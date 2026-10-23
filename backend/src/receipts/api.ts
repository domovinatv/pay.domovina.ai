import type { Context, Hono } from 'hono';
import { createPublicClient, hexToBytes, isAddress, verifyMessage, type Hex } from 'viem';
import { gnosis } from 'viem/chains';

import type { Env } from '../types';
import { sendAlert } from '../alerts';
import { getIntent } from '../intents/db';
import { getAnchor, latestAnchor, listAnchors, otsHasBitcoin, proofsForAnchor, type AnchorRow, type LeafProof } from './anchor';
import { linkReceipts } from './link';
import { isReceiptSid, receiptSidMatches } from './sid';
import { readTransport } from '../chain/gnosisRpc';

/// Receipt API (ADR 0022 §4, §3a).
///
///   GET  /api/intents/:sid/receipt   public: the direct receipt only
///   POST /api/intents/:sid/receipt   owner-signed: + payments covered lazily
///   GET  /api/receipts/anchors[?after=N] | /latest | /:seq | /:seq.ots   the anchor chain
///
/// The lazy list is owner-only: anyone can learn a sid, and a public list
/// would expose every earlier payment from one IBAN (ADR 0022 §3a).

export const RECEIPT_VERSION = 'mpt-receipt-v1';
const SIGNATURE_MAX_SKEW_S = 300;

/// The exact text the owner signs (EIP-191 personal_sign).
export function receiptRequestMessage(sid: string, ts: number): string {
  return `MPT potvrda o uplati\nsid: ${sid}\nvrijeme: ${ts}`;
}

interface LeafRow {
  id: number;
  kind: 'direct' | 'lazy';
  sid: string;
  order_id: string;
  tx_hash: string | null;
  amount_cents: number;
  placed_at: string | null;
  leaf_hash: string;
  anchor_id: number | null;
  target_address: string | null;
  tenant_id: string | null;
}

interface ReceiptPayment {
  kind: 'direct' | 'lazy';
  order_id: string;
  tx_hash: string | null;
  amount_cents: number;
  placed_at: string | null;
  leaf_hash: string;
  /// Where that payment went, so a lazy receipt spanning many payees does not
  /// read as if every payment was for this intent. Informational: not part of
  /// the leaf hash (the Gnosis tx itself shows the recipient).
  target_address: string | null;
  tenant_id: string | null;
  anchor: LeafProof | null;
}

async function leavesFor(env: Env, sid: string): Promise<LeafRow[]> {
  const rows = await env.DB.prepare(
    `SELECT l.id, l.kind, l.sid, l.order_id, l.tx_hash, l.amount_cents, l.placed_at, l.leaf_hash, l.anchor_id,
            (SELECT f.target_address FROM monerium_forwards f
              WHERE f.order_id = l.order_id AND f.status IN ('confirmed', 'resolved_offrail')
              ORDER BY f.id DESC LIMIT 1) AS target_address,
            COALESCE(
              (SELECT f.tenant_id FROM monerium_forwards f
                WHERE f.order_id = l.order_id AND f.status IN ('confirmed', 'resolved_offrail')
                ORDER BY f.id DESC LIMIT 1),
              (SELECT o.tenant_id FROM monerium_orders o WHERE o.id = l.order_id)) AS tenant_id
       FROM receipt_leaves l WHERE l.sid = ? ORDER BY l.placed_at, l.id`,
  ).bind(sid).all<LeafRow>();
  return rows.results;
}

function toPayment(l: LeafRow, proofs: Map<number, Map<number, LeafProof>>): ReceiptPayment {
  return {
    kind: l.kind,
    order_id: l.order_id,
    tx_hash: l.tx_hash,
    amount_cents: l.amount_cents,
    placed_at: l.placed_at,
    leaf_hash: l.leaf_hash,
    target_address: l.target_address ? l.target_address.toLowerCase() : null,
    tenant_id: l.tenant_id,
    anchor: l.anchor_id !== null ? proofs.get(l.anchor_id)?.get(l.id) ?? null : null,
  };
}

/// Why a receipt sid has no direct receipt (yet). Mirrors the ADR 0022 matrix.
async function directStatus(env: Env, sid: string): Promise<{ status: string; forward_tx_hash: string | null }> {
  const fwd = await env.DB.prepare(
    `SELECT status, memo_prefix, tx_hash FROM monerium_forwards WHERE sid = ?
      ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'submitted' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, id DESC
      LIMIT 1`,
  ).bind(sid).first<{ status: string; memo_prefix: string | null; tx_hash: string | null }>();
  if (!fwd) return { status: 'awaiting_payment', forward_tx_hash: null };
  if (fwd.memo_prefix === 'code' || fwd.memo_prefix === 'auto' || fwd.memo_prefix === 'manual') {
    return { status: 'unbound_stray', forward_tx_hash: fwd.tx_hash };
  }
  if (fwd.status === 'confirmed') return { status: 'confirmed', forward_tx_hash: fwd.tx_hash };
  if (fwd.status === 'pending' || fwd.status === 'submitted') return { status: 'settling', forward_tx_hash: fwd.tx_hash };
  return { status: `not_delivered:${fwd.status}`, forward_tx_hash: fwd.tx_hash };
}

async function buildReceipt(env: Env, sid: string, includeLazy: boolean) {
  const intent = await getIntent(env, sid);
  if (!intent) return null;
  const direct = await directStatus(env, sid);
  const all = await leavesFor(env, sid);
  const shown = all.filter((l) => includeLazy || l.kind === 'direct');
  const proofs = new Map<number, Map<number, LeafProof>>();
  for (const seq of new Set(shown.flatMap((l) => (l.anchor_id !== null ? [l.anchor_id] : [])))) {
    proofs.set(seq, await proofsForAnchor(env, seq));
  }
  const payments = shown.map((l) => toPayment(l, proofs));
  return {
    version: RECEIPT_VERSION,
    sid,
    chain_id: 100,
    status: payments.some((p) => p.kind === 'direct') ? 'issued' : direct.status,
    intent: {
      amount_cents: intent.amount_cents,
      currency: intent.currency,
      label: intent.label,
      target_address: intent.target_address,
      tenant_id: intent.tenant_id,
      created_at: intent.created_at,
      paid_at: intent.paid_at,
    },
    forward_tx_hash: direct.forward_tx_hash,
    // Where the forward's Payment event lives, when the registry is deployed.
    payment_registry: env.PAYMENT_REGISTRY_ADDRESS || null,
    payments,
    lazy_included: includeLazy,
  };
}

/// EOA signature locally; anything else (a Safe owner) via ERC-1271/6492 on
/// Gnosis. Never throws.
async function ownerSigned(env: Env, owner: Hex, message: string, signature: Hex): Promise<boolean> {
  try {
    if (await verifyMessage({ address: owner, message, signature })) return true;
  } catch {
    /* not an EOA signature — fall through to the contract check */
  }
  try {
    const client = createPublicClient({ chain: gnosis, transport: readTransport(env, 'gnosis', env.GNOSIS_RPC_URL) });
    return await client.verifyMessage({ address: owner, message, signature });
  } catch {
    return false;
  }
}

function linkNow(c: Context<{ Bindings: Env }>, sid: string) {
  return linkReceipts(c.env, { alert: (t) => sendAlert(c.env, t) }, sid).catch((e) => {
    console.error(`receipts: on-demand link ${sid} failed: ${e}`);
  });
}

export function registerReceiptRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get('/:sid/receipt', async (c) => {
    const sid = c.req.param('sid');
    if (!isReceiptSid(sid)) return c.json({ error: 'not_receipt_sid' }, 404);
    await linkNow(c, sid);
    const receipt = await buildReceipt(c.env, sid, false);
    if (!receipt) return c.json({ error: 'intent_not_found' }, 404);
    return c.json(receipt);
  });

  api.post('/:sid/receipt', async (c) => {
    const sid = c.req.param('sid');
    if (!isReceiptSid(sid)) return c.json({ error: 'not_receipt_sid' }, 404);
    let body: { owner?: string; salt?: string; ts?: number; signature?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const { owner, salt, ts, signature } = body;
    if (!owner || !isAddress(owner, { strict: false }) || !salt || !signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!receiptSidMatches(sid, owner, salt)) return c.json({ error: 'owner_does_not_match_sid' }, 403);
    const now = Math.floor(Date.now() / 1000);
    if (typeof ts !== 'number' || Math.abs(now - ts) > SIGNATURE_MAX_SKEW_S) {
      return c.json({ error: 'stale_signature' }, 403);
    }
    if (!(await ownerSigned(c.env, owner as Hex, receiptRequestMessage(sid, ts), signature as Hex))) {
      return c.json({ error: 'bad_signature' }, 403);
    }
    await linkNow(c, sid);
    const receipt = await buildReceipt(c.env, sid, true);
    if (!receipt) return c.json({ error: 'intent_not_found' }, 404);
    return c.json({ ...receipt, owner: owner.toLowerCase(), salt: salt.toLowerCase() });
  });
}

/// Public anchor chain, read by the checkpoint Action (ADR 0023 §3) and by
/// anyone verifying a receipt. Everything here is already public by design.
function anchorJson(a: AnchorRow) {
  return {
    seq: a.seq,
    prev_chain_head: a.prev_chain_head,
    chain_head: a.chain_head,
    root: a.root,
    leaf_count: a.leaf_count,
    total_leaves: a.total_leaves,
    total_cents: a.total_cents,
    lazy_count: a.lazy_count,
    ots_available: a.ots !== null,
    ots_bitcoin: a.ots !== null && otsHasBitcoin(hexToBytes(a.ots as Hex)),
    ots_calendars: a.ots_calendars ? (JSON.parse(a.ots_calendars) as string[]) : [],
    chain_tx_hash: a.chain_tx_hash,
    created_at: a.created_at,
  };
}

export function registerReceiptAnchorRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get('/anchors', async (c) => {
    const after = Number(c.req.query('after') ?? '0');
    if (!Number.isSafeInteger(after) || after < 0) return c.json({ error: 'invalid_after' }, 400);
    const rows = await listAnchors(c.env, after, 100);
    return c.json({ anchors: rows.map(anchorJson) });
  });

  api.get('/anchors/latest', async (c) => {
    const row = await latestAnchor(c.env);
    if (!row) return c.json({ error: 'no_anchor_yet' }, 404);
    return c.json(anchorJson(row));
  });

  api.get('/anchors/:seq{[0-9]+}', async (c) => {
    const row = await getAnchor(c.env, Number(c.req.param('seq')));
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(anchorJson(row));
  });

  api.get('/anchors/:file', async (c) => {
    const m = /^(\d+)\.ots$/.exec(c.req.param('file'));
    if (!m) return c.json({ error: 'not_found' }, 404);
    const row = await getAnchor(c.env, Number(m[1]));
    if (!row?.ots) return c.json({ error: 'ots_not_available' }, 404);
    return new Response(hexToBytes(row.ots as Hex), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="mpt-receipt-anchor-${m[1]}.ots"`,
        'Cache-Control': 'public, max-age=300',
      },
    });
  });
}
