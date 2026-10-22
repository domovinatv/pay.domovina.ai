import { Hono } from 'hono';

import type { Env } from '../types';
import { normalizeIban, parseAmountCents } from '../monerium/orderState';
import { edgeCached, MissLimited, workerEdgeDeps } from '../publicRead/edgeCache';

/// Public payer tags for one payout address: who paid, anonymised to initials
/// and the last 4 IBAN characters, so a payer watching any screen recognises
/// their own payment the moment Monerium receives it — before it is on chain.
///
/// Opt-in per tenant (`tenants.public_payer_tags`, migration 0032). The full
/// name and IBAN never leave the rail, and neither does the sid (a capability).

export const PAYERS_LIMIT = 50;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/// Legal-form words are not a person's initials ("ITALK D.O.O." → "I.").
const LEGAL_FORMS = new Set(['doo', 'jdoo', 'dd', 'obrt', 'gmbh', 'ltd', 'llc', 'uab', 'sa', 'srl', 'oü', 'ou', 'as']);

/// "Matija Stepanić" → "M. S."; "STEPANIC MATIJA" → "S. M."; one word → "M.".
/// First and last word only, so a long name does not grow into a fingerprint.
export function initials(name: string | null | undefined): string | null {
  const words = (name ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 0 && /^\p{L}/u.test(w) && !LEGAL_FORMS.has(w.toLowerCase()));
  if (words.length === 0) return null;
  const pick = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
  return pick.map((w) => `${w[0].toLocaleUpperCase('hr')}.`).join(' ');
}

export function ibanLast4(iban: string | null | undefined): string | null {
  const s = normalizeIban(iban);
  return s && s.length >= 8 ? s.slice(-4) : null;
}

export async function payerRef(sid: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sid));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PayerTag {
  initials: string | null;
  iban_last4: string | null;
  amount_cents: number | null;
  /// Monerium `placedAt` (ISO): when the bank transfer reached Monerium.
  received_at: string | null;
  /// 'received' until EURe is minted, then 'minted'.
  state: 'received' | 'minted';
  /// Every on-chain hash of this payment (mint and forward), lowercase — the
  /// client matches its chain rows by any of them.
  tx_hashes: string[];
  /// First 16 hex of SHA-256(sid): lets the payer's own browser, which knows
  /// the sid, recognise this row as its own without the sid being published.
  ref: string | null;
}

interface Row {
  sid: string | null;
  state: string;
  amount: string;
  placed_at: string | null;
  counterpart_iban: string | null;
  counterpart_name: string | null;
  tx_hashes: string | null;
  intent_tx: string | null;
  forward_txs: string | null;
}

function parseHashes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

export async function listPayerTags(env: Env, address: string): Promise<PayerTag[]> {
  const addr = address.toLowerCase();
  // An order belongs to the address through its intent, a rail forward, or a
  // direct mint. Tenant = the order's (NULL rows are the default tenant).
  // Three indexed lookups (migration 0033) instead of one OR over a scan of
  // every issue order.
  const res = await env.DB.prepare(
    `WITH ids AS (
       SELECT id FROM monerium_orders WHERE lower(address) = ?1
       UNION SELECT monerium_order_id FROM payment_intents
              WHERE target_address = ?1 AND monerium_order_id IS NOT NULL
       UNION SELECT order_id FROM monerium_forwards
              WHERE target_address = ?1 AND status IN ('pending', 'submitted', 'confirmed'))
     SELECT (SELECT i.sid FROM payment_intents i WHERE i.monerium_order_id = o.id
              ORDER BY i.paid_at DESC LIMIT 1) AS sid,
            o.state, o.amount, o.placed_at, o.counterpart_iban, o.counterpart_name, o.tx_hashes,
            (SELECT i.forward_tx_hash FROM payment_intents i WHERE i.monerium_order_id = o.id
              ORDER BY i.paid_at DESC LIMIT 1) AS intent_tx,
            (SELECT json_group_array(f.tx_hash) FROM monerium_forwards f
              WHERE f.order_id = o.id AND f.tx_hash IS NOT NULL) AS forward_txs
       FROM ids
       JOIN monerium_orders o ON o.id = ids.id
       JOIN tenants t ON t.id = COALESCE(o.tenant_id, ?2)
      WHERE o.kind = 'issue' AND o.state IN ('placed', 'pending', 'processed')
        AND t.public_payer_tags = 1
      ORDER BY o.placed_at DESC
      LIMIT ?3`,
  )
    .bind(addr, env.DEFAULT_TENANT_ID, PAYERS_LIMIT)
    .all<Row>();
  return Promise.all(res.results.map(async (r) => {
    const hashes = [...parseHashes(r.tx_hashes), ...parseHashes(r.forward_txs), ...(r.intent_tx ? [r.intent_tx] : [])];
    return {
      initials: initials(r.counterpart_name),
      iban_last4: ibanLast4(r.counterpart_iban),
      amount_cents: parseAmountCents(r.amount),
      received_at: r.placed_at,
      state: r.state === 'processed' ? 'minted' : 'received',
      tx_hashes: [...new Set(hashes.map((h) => h.toLowerCase()))],
      ref: r.sid ? await payerRef(r.sid) : null,
    };
  }));
}

export function buildPayersApi() {
  const api = new Hono<{ Bindings: Env }>();
  api.get('/:address', async (c) => {
    const address = c.req.param('address');
    if (!ADDR_RE.test(address)) return c.json({ error: 'invalid_address' }, 400);
    const addr = address.toLowerCase();
    try {
      // Edge-cached (ADR 0030): every open project page polls this, and D1
      // also settles payments.
      const body = await edgeCached(
        workerEdgeDeps(c.env, c.req.raw, c.executionCtx),
        `${new URL(c.req.url).origin}/api/payers/${addr}`,
        async () => JSON.stringify({ data: await listPayerTags(c.env, addr) }),
      );
      c.header('Cache-Control', 'public, max-age=5');
      c.header('Content-Type', 'application/json');
      return c.body(body);
    } catch (e) {
      if (e instanceof MissLimited) return c.json({ error: 'rate_limited' }, 429);
      throw e;
    }
  });
  return api;
}
