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
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO monerium_webhook_events
       (order_id, event_type, signature_ok, payload, received_at, headers_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.orderId,
      args.eventType,
      args.signatureOk ? 1 : 0,
      args.payload,
      Math.floor(Date.now() / 1000),
      args.headersJson ?? null,
    )
    .run();
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
