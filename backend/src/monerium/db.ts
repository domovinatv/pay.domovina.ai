import type { Env } from '../types';
import type { MoneriumOrder } from './types';
import { normalizeIban, orderStateRankSql } from './orderState';

export interface MoneriumOrderRow {
  id: string;
  profile_id: string | null;
  account_id: string | null;
  kind: string;
  state: string;
  amount: string;
  currency: string;
  address: string | null;
  chain: string | null;
  counterpart_iban: string | null;
  counterpart_name: string | null;
  memo: string | null;
  reference_number: string | null;
  tx_hashes: string | null;
  placed_at: string | null;
  processed_at: string | null;
  raw_json: string;
  updated_at: number;
}

/// Upsert the latest snapshot of a Monerium order. Monotonic: a snapshot whose
/// state ranks BELOW the stored one (e.g. a retried `order.created` arriving
/// after `order.updated processed`) is ignored. Returns false in that case so
/// the caller can skip side effects for the stale event.
export async function upsertMoneriumOrder(
  env: Env,
  order: MoneriumOrder,
): Promise<boolean> {
  const ident = order.counterpart?.identifier;
  const counterpartIban =
    ident && ident.standard === 'iban' ? ident.iban : null;
  const res = await env.DB.prepare(
    `INSERT INTO monerium_orders
       (id, profile_id, account_id, kind, state, amount, currency,
        address, chain, counterpart_iban, counterpart_name, memo,
        reference_number, tx_hashes, placed_at, processed_at,
        raw_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       amount = excluded.amount,
       currency = excluded.currency,
       address = excluded.address,
       chain = excluded.chain,
       counterpart_iban = excluded.counterpart_iban,
       counterpart_name = excluded.counterpart_name,
       memo = excluded.memo,
       reference_number = excluded.reference_number,
       tx_hashes = excluded.tx_hashes,
       placed_at = excluded.placed_at,
       processed_at = excluded.processed_at,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at
     WHERE ${orderStateRankSql('excluded.state')} >= ${orderStateRankSql('monerium_orders.state')}`,
  )
    .bind(
      order.id,
      order.profile ?? null,
      order.accountId ?? null,
      order.kind ?? 'unknown',
      order.state ?? order.meta?.state ?? 'placed',
      order.amount ?? '0',
      order.currency ?? 'eur',
      order.address ?? null,
      order.chain ?? null,
      counterpartIban,
      order.counterpart?.details?.name ?? null,
      order.memo ?? null,
      order.referenceNumber ?? null,
      order.meta?.txHashes ? JSON.stringify(order.meta.txHashes) : null,
      order.meta?.placedAt ?? null,
      order.meta?.processedAt ?? null,
      JSON.stringify(order),
      Math.floor(Date.now() / 1000),
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/// Has a payment from this IBAN been processed before (any order but
/// `excludeOrderId`)? Monerium's first-payment screening keys on the payer, so
/// this predicts whether a freshly received order will be held for review.
export async function isKnownPayer(
  env: Env,
  iban: string | null,
  excludeOrderId: string,
): Promise<boolean | null> {
  const norm = normalizeIban(iban);
  if (!norm) return null;
  const row = await env.DB.prepare(
    `SELECT 1 AS hit FROM monerium_orders
      WHERE kind = 'issue' AND state = 'processed' AND id <> ?
        AND REPLACE(UPPER(counterpart_iban), ' ', '') = ?
      LIMIT 1`,
  )
    .bind(excludeOrderId, norm)
    .first<{ hit: number }>();
  return row !== null;
}

export async function listMoneriumOrders(
  env: Env,
  limit = 100,
): Promise<MoneriumOrderRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM monerium_orders
     ORDER BY COALESCE(placed_at, '') DESC, updated_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<MoneriumOrderRow>();
  return res.results;
}

export async function getMoneriumOrder(
  env: Env,
  orderId: string,
): Promise<MoneriumOrderRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM monerium_orders WHERE id = ?`,
  )
    .bind(orderId)
    .first<MoneriumOrderRow>();
  return row ?? null;
}

export async function recordMoneriumWebhookEvent(
  env: Env,
  args: {
    orderId: string | null;
    eventType: string;
    signatureOk: boolean;
    payload: string;
    headersJson?: string;
    sidExtracted?: string | null;
    amountCents?: number | null;
    currency?: string | null;
    processingNote?: string | null;
  },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO monerium_webhook_events
       (order_id, event_type, signature_ok, payload, received_at,
        headers_json, sid_extracted, amount_cents, currency, processing_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.orderId,
      args.eventType,
      args.signatureOk ? 1 : 0,
      args.payload,
      Math.floor(Date.now() / 1000),
      args.headersJson ?? null,
      args.sidExtracted ?? null,
      args.amountCents ?? null,
      args.currency ?? null,
      args.processingNote ?? null,
    )
    .run();
  return (res.meta?.last_row_id as number | undefined) ?? 0;
}

export interface MoneriumEventRow {
  id: number;
  order_id: string | null;
  event_type: string | null;
  signature_ok: number;
  payload: string;
  received_at: number;
  headers_json: string | null;
  sid_extracted: string | null;
  amount_cents: number | null;
  currency: string | null;
  processing_note: string | null;
}

export interface ListEventsFilter {
  limit?: number;
  offset?: number;
  sid?: string;
  signatureOk?: boolean;
  eventType?: string;
}

export async function listMoneriumWebhookEvents(
  env: Env,
  filter: ListEventsFilter = {},
): Promise<{ items: MoneriumEventRow[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.sid) {
    where.push('sid_extracted = ?');
    args.push(filter.sid);
  }
  if (filter.signatureOk !== undefined) {
    where.push('signature_ok = ?');
    args.push(filter.signatureOk ? 1 : 0);
  }
  if (filter.eventType) {
    where.push('event_type = ?');
    args.push(filter.eventType);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM monerium_webhook_events ${whereSql}`,
  )
    .bind(...args)
    .first<{ c: number }>();
  const itemsRes = await env.DB.prepare(
    `SELECT * FROM monerium_webhook_events ${whereSql}
     ORDER BY id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...args, limit, offset)
    .all<MoneriumEventRow>();
  return { items: itemsRes.results, total: totalRow?.c ?? 0 };
}

export async function getMoneriumWebhookEvent(
  env: Env,
  id: number,
): Promise<MoneriumEventRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM monerium_webhook_events WHERE id = ?`,
  )
    .bind(id)
    .first<MoneriumEventRow>();
  return row ?? null;
}

export interface MoneriumForwardRow {
  id: number;
  order_id: string;
  target_address: string;
  amount_wei: string;
  amount_cents: number | null;
  sid: string | null;
  memo_prefix: string | null;
  tx_hash: string | null;
  /// 'blocked' = the tenant payout whitelist refused this destination, so no
  /// TX was ever built. Distinct from 'failed' (broadcast/RPC/chain error) so
  /// an operator can tell a policy refusal from an infrastructure problem.
  status: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'blocked';
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

/// Returns the new row id, or 0 when the live-forward latch refused the insert
/// (an order may have at most one pending/submitted/confirmed forward).
export async function insertForward(
  env: Env,
  args: {
    orderId: string;
    targetAddress: string;
    amountWei: string;
    amountCents: number | null;
    sid: string | null;
    memoPrefix: string | null;
    status: MoneriumForwardRow['status'];
    txHash?: string | null;
    error?: string | null;
  },
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  // ON CONFLICT DO NOTHING (not INSERT OR IGNORE): only the live-forward
  // latch (ux_forwards_live, migration 0016) may swallow the insert — a NOT
  // NULL or other constraint failure must still throw.
  const res = await env.DB.prepare(
    `INSERT INTO monerium_forwards
       (order_id, target_address, amount_wei, amount_cents, sid, memo_prefix,
        tx_hash, status, error, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      args.orderId,
      args.targetAddress,
      args.amountWei,
      args.amountCents,
      args.sid,
      args.memoPrefix,
      args.txHash ?? null,
      args.status,
      args.error ?? null,
      args.txHash ? 1 : 0,
      now,
      now,
    )
    .run();
  // 0 = another caller already holds the live forward for this order.
  if ((res.meta?.changes ?? 0) === 0) return 0;
  return (res.meta?.last_row_id as number | undefined) ?? 0;
}

export async function updateForward(
  env: Env,
  id: number,
  patch: Partial<Pick<MoneriumForwardRow, 'status' | 'tx_hash' | 'error' | 'attempts'>>,
): Promise<void> {
  const fields: string[] = ['updated_at = ?'];
  const args: unknown[] = [Math.floor(Date.now() / 1000)];
  if (patch.status !== undefined) { fields.push('status = ?'); args.push(patch.status); }
  if (patch.tx_hash !== undefined) { fields.push('tx_hash = ?'); args.push(patch.tx_hash); }
  if (patch.error !== undefined) { fields.push('error = ?'); args.push(patch.error); }
  if (patch.attempts !== undefined) { fields.push('attempts = ?'); args.push(patch.attempts); }
  args.push(id);
  await env.DB.prepare(
    `UPDATE monerium_forwards SET ${fields.join(', ')} WHERE id = ?`,
  ).bind(...args).run();
}

/// Atomic `submitted → confirmed` transition. Returns true ONLY for the one
/// caller that performed the flip — the paid-flip + merchant/campaign webhook
/// settlement effects key off this, so the post-broadcast waitUntil poll, the
/// cron reconcile, and the status read path can all race safely.
export async function confirmForwardOnce(
  env: Env,
  id: number,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE monerium_forwards
        SET status = 'confirmed', updated_at = ?
      WHERE id = ? AND status = 'submitted'`,
  )
    .bind(Math.floor(Date.now() / 1000), id)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/// Broadcast-but-unconfirmed forwards older than the cutoff — the cron
/// reconcile set. `tx_hash IS NOT NULL` is belt-and-braces: a `submitted`
/// row always gets its hash in the same update.
export async function listSubmittedForwardsOlderThan(
  env: Env,
  olderThanUnix: number,
): Promise<MoneriumForwardRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM monerium_forwards
      WHERE status = 'submitted' AND tx_hash IS NOT NULL AND updated_at < ?
      ORDER BY id ASC LIMIT 50`,
  )
    .bind(olderThanUnix)
    .all<MoneriumForwardRow>();
  return res.results;
}

export async function getForwardByOrder(
  env: Env,
  orderId: string,
): Promise<MoneriumForwardRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM monerium_forwards WHERE order_id = ?
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(orderId)
    .first<MoneriumForwardRow>();
  return row ?? null;
}

export async function listForwards(
  env: Env,
  filter: { limit?: number; offset?: number; status?: string } = {},
): Promise<{ items: MoneriumForwardRow[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) { where.push('status = ?'); args.push(filter.status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM monerium_forwards ${whereSql}`,
  ).bind(...args).first<{ c: number }>();
  const itemsRes = await env.DB.prepare(
    `SELECT * FROM monerium_forwards ${whereSql}
     ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).bind(...args, limit, offset).all<MoneriumForwardRow>();
  return { items: itemsRes.results, total: totalRow?.c ?? 0 };
}

/// Returns true if this webhook-id was already processed (and was a no-op
/// this call), false if it was inserted now and the caller should process.
export async function alreadyProcessedEvent(
  env: Env,
  webhookId: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO monerium_processed_event_ids (webhook_id, received_at)
     VALUES (?, ?)`,
  )
    .bind(webhookId, Math.floor(Date.now() / 1000))
    .run();
  // D1 result: meta.changes === 0 means the row already existed.
  return (res.meta?.changes ?? 0) === 0;
}

/// Undo `alreadyProcessedEvent`'s claim when processing failed, so Monerium's
/// retry of the SAME webhook-id is processed instead of dropped as a
/// duplicate (Fable5 review BW-03). The claim itself stays an atomic latch:
/// two concurrent deliveries still cannot both process.
export async function releaseProcessedEvent(
  env: Env,
  webhookId: string,
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM monerium_processed_event_ids WHERE webhook_id = ?`,
  )
    .bind(webhookId)
    .run();
}
