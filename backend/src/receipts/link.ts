import type { Env } from '../types';
import { normalizeIban, parseAmountCents } from '../monerium/orderState';
import { leafHash } from './merkle';
import { isReceiptSid } from './sid';

/// Receipt issuance (ADR 0022 §3, §3a). Runs from the cron and on demand from
/// the receipt API; idempotent (receipt_leaves.order_id is UNIQUE).
///
/// Anchor = a forward of a receipt sid that came in the payer's OWN remittance
/// (memo_prefix 'mpt'/'cmp', never the stray resolver's 'auto'/'manual').
/// Each confirmed anchor gets a direct leaf, then covers every earlier,
/// delivered, not-yet-covered payment from the same payer IBAN since the
/// previous anchor from that IBAN (lazy leaves).

const NORM_IBAN = `REPLACE(UPPER(o.counterpart_iban), ' ', '')`;
/// SQL prefilter for receipt sids; isReceiptSid() is the exact check.
const RECEIPT_SID_SQL = `f.sid LIKE 'r1%' AND length(f.sid) = 26`;
const MEMO_CARRIED = `f.memo_prefix IN ('mpt', 'cmp')`;

interface AnchorRow {
  order_id: string;
  sid: string;
  tx_hash: string | null;
  amount_cents: number | null;
  amount: string;
  placed_at: string | null;
  counterpart_iban: string | null;
  counterpart_name: string | null;
  order_tx_hashes: string | null;
}

interface CoveredRow {
  id: string;
  amount: string;
  tx_hashes: string | null;
  placed_at: string | null;
  counterpart_name: string | null;
}

export interface LinkResult {
  anchors: number;
  lazy: number;
  mismatches: number;
}

export interface LinkDeps {
  alert(text: string): Promise<void>;
  nowUnix?(): number;
}

function firstTx(json: string | null): string | null {
  if (!json) return null;
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) && typeof arr[0] === 'string' ? arr[0] : null;
  } catch {
    return null;
  }
}

/// Names are compared loosely (case, diacritics, spacing, word order): banks
/// format the same holder differently. A difference only alerts (§3a rule 7).
export function sameHolder(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  const norm = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
      .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join(' ');
  return norm(a) === norm(b);
}

/// Confirmed anchors without a direct leaf yet, oldest first (so an earlier
/// anchor always links before a later one in the same run).
async function pendingAnchors(env: Env, sid?: string): Promise<AnchorRow[]> {
  const rows = await env.DB.prepare(
    `SELECT f.order_id, f.sid, f.tx_hash, f.amount_cents, o.amount, o.placed_at,
            o.counterpart_iban, o.counterpart_name, o.tx_hashes AS order_tx_hashes
       FROM monerium_forwards f
       JOIN monerium_orders o ON o.id = f.order_id
      WHERE ${RECEIPT_SID_SQL} AND ${MEMO_CARRIED} AND f.status = 'confirmed'
        AND (?1 IS NULL OR f.sid = ?1)
        AND NOT EXISTS (SELECT 1 FROM receipt_leaves l WHERE l.order_id = f.order_id)
      ORDER BY o.placed_at ASC
      LIMIT 50`,
  ).bind(sid ?? null).all<AnchorRow>();
  return rows.results.filter((r) => isReceiptSid(r.sid));
}

/// placed_at of the previous anchor from the same IBAN (any live status, so
/// the boundary does not depend on which forward confirmed first).
async function previousAnchorPlacedAt(env: Env, iban: string, before: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT MAX(o.placed_at) AS p
       FROM monerium_forwards f
       JOIN monerium_orders o ON o.id = f.order_id
      WHERE ${RECEIPT_SID_SQL} AND ${MEMO_CARRIED}
        AND f.status IN ('pending', 'submitted', 'confirmed')
        AND ${NORM_IBAN} = ?1 AND o.placed_at < ?2`,
  ).bind(iban, before).first<{ p: string | null }>();
  return row?.p ?? null;
}

/// Earlier payments from `iban` that §3a covers: processed issue orders that
/// reached the payee (forward confirmed, or settled off-rail), not themselves
/// anchors, not yet covered.
async function coverable(env: Env, iban: string, after: string | null, before: string): Promise<CoveredRow[]> {
  const rows = await env.DB.prepare(
    `SELECT o.id, o.amount, o.tx_hashes, o.placed_at, o.counterpart_name
       FROM monerium_orders o
      WHERE o.kind = 'issue' AND o.state = 'processed'
        AND ${NORM_IBAN} = ?1
        AND o.placed_at < ?2
        AND (?3 IS NULL OR o.placed_at > ?3)
        AND NOT EXISTS (SELECT 1 FROM receipt_leaves l WHERE l.order_id = o.id)
        AND EXISTS (SELECT 1 FROM monerium_forwards f
                     WHERE f.order_id = o.id AND f.status IN ('confirmed', 'resolved_offrail'))
        AND NOT EXISTS (SELECT 1 FROM monerium_forwards f
                         WHERE f.order_id = o.id AND ${RECEIPT_SID_SQL} AND ${MEMO_CARRIED}
                           AND f.status IN ('pending', 'submitted', 'confirmed'))
      ORDER BY o.placed_at ASC`,
  ).bind(iban, before, after).all<CoveredRow>();
  return rows.results;
}

async function insertLeaf(
  env: Env,
  row: {
    kind: 'direct' | 'lazy';
    sid: string;
    orderId: string;
    txHash: string | null;
    amountCents: number;
    placedAt: string | null;
    nameMismatch: boolean;
    now: number;
  },
): Promise<boolean> {
  const hash = leafHash({
    kind: row.kind, sid: row.sid, orderId: row.orderId, txHash: row.txHash, amountCents: row.amountCents,
  });
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO receipt_leaves
       (kind, sid, order_id, tx_hash, amount_cents, placed_at, leaf_hash, name_mismatch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.kind, row.sid, row.orderId, row.txHash, row.amountCents, row.placedAt, hash,
    row.nameMismatch ? 1 : 0, row.now,
  ).run();
  return (res.meta?.changes ?? 0) > 0;
}

/// Issue direct leaves for confirmed anchors and their lazy leaves. `sid`
/// narrows the run to one receipt (the API's on-demand path).
export async function linkReceipts(env: Env, deps: LinkDeps, sid?: string): Promise<LinkResult> {
  const now = deps.nowUnix?.() ?? Math.floor(Date.now() / 1000);
  const out: LinkResult = { anchors: 0, lazy: 0, mismatches: 0 };
  for (const a of await pendingAnchors(env, sid)) {
    const amountCents = a.amount_cents ?? parseAmountCents(a.amount) ?? 0;
    // Direct mode settles without a forward tx; the mint is the payment then.
    const inserted = await insertLeaf(env, {
      kind: 'direct', sid: a.sid, orderId: a.order_id, txHash: a.tx_hash ?? firstTx(a.order_tx_hashes),
      amountCents, placedAt: a.placed_at, nameMismatch: false, now,
    });
    if (!inserted) continue;
    out.anchors++;

    const iban = normalizeIban(a.counterpart_iban);
    if (!iban || !a.placed_at) continue; // §3 case 6: nothing to match on
    const after = await previousAnchorPlacedAt(env, iban, a.placed_at);
    for (const c of await coverable(env, iban, after, a.placed_at)) {
      const mismatch = !sameHolder(a.counterpart_name, c.counterpart_name);
      const ok = await insertLeaf(env, {
        kind: 'lazy', sid: a.sid, orderId: c.id, txHash: firstTx(c.tx_hashes),
        amountCents: parseAmountCents(c.amount) ?? 0, placedAt: c.placed_at, nameMismatch: mismatch, now,
      });
      if (!ok) continue;
      out.lazy++;
      if (mismatch) {
        out.mismatches++;
        await deps.alert(
          `🧾 <b>Naknadna potvrda: različito ime uplatitelja, isti IBAN</b>\n` +
            `potvrda: <code>${a.sid}</code> (${a.counterpart_name ?? '-'})\n` +
            `pokrivena uplata: <code>${c.id}</code> (${c.counterpart_name ?? '-'})\n` +
            `Povezano po IBAN-u (ADR 0022 §3a); provjeriti ako je sumnjivo.`,
        ).catch(() => {});
      }
    }
  }
  return out;
}
