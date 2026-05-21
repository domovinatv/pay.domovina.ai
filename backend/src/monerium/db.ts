import type { Env } from '../types';
import type { MoneriumOrder } from './types';

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

export async function upsertMoneriumOrder(
  env: Env,
  order: MoneriumOrder,
): Promise<void> {
  const ident = order.counterpart?.identifier;
  const counterpartIban =
    ident && ident.standard === 'iban' ? ident.iban : null;
  await env.DB.prepare(
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
       updated_at = excluded.updated_at`,
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
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

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
  const res = await env.DB.prepare(
    `INSERT INTO monerium_forwards
       (order_id, target_address, amount_wei, amount_cents, sid, memo_prefix,
        tx_hash, status, error, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
