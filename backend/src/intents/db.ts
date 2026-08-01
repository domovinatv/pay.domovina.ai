import type { Env } from '../types';

export interface PaymentIntentRow {
  sid: string;
  target_address: string;
  amount_cents: number;
  currency: string;
  label: string | null;
  metadata_json: string | null;
  state: 'pending' | 'paid' | 'expired';
  created_at: number;
  expires_at: number;
  paid_at: number | null;
  monerium_order_id: string | null;
  forward_id: number | null;
  forward_tx_hash: string | null;
  amount_received_cents: number | null;
  /// Tenant that authorised this intent (migration 0013). NULL only for rows
  /// created before tenants existed; the forward gate falls back to
  /// DEFAULT_TENANT_ID for those.
  tenant_id: string | null;
}

export interface CreateIntentArgs {
  sid: string;
  targetAddress: string;
  amountCents: number;
  currency?: string;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
  ttlSeconds: number;
  tenantId: string;
}

export async function createIntent(
  env: Env,
  args: CreateIntentArgs,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO payment_intents
       (sid, target_address, amount_cents, currency, label, metadata_json,
        state, created_at, expires_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  )
    .bind(
      args.sid,
      args.targetAddress.toLowerCase(),
      args.amountCents,
      args.currency ?? 'eur',
      args.label ?? null,
      args.metadata ? JSON.stringify(args.metadata) : null,
      now,
      now + args.ttlSeconds,
      args.tenantId,
    )
    .run();
}

export async function getIntent(
  env: Env,
  sid: string,
): Promise<PaymentIntentRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM payment_intents WHERE sid = ?`,
  )
    .bind(sid)
    .first<PaymentIntentRow>();
  return row ?? null;
}

/// Idempotently mark an intent paid. Only transitions `pending → paid`
/// — already-paid or expired intents are left untouched so we never
/// overwrite earlier (correct) settlement data with later (orphan)
/// webhook retries.
export async function markIntentPaid(
  env: Env,
  sid: string,
  args: {
    moneriumOrderId: string;
    forwardId: number;
    forwardTxHash: string | null;
    amountReceivedCents: number | null;
  },
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    `UPDATE payment_intents
        SET state = 'paid',
            paid_at = ?,
            monerium_order_id = ?,
            forward_id = ?,
            forward_tx_hash = ?,
            amount_received_cents = ?
      WHERE sid = ?
        AND state = 'pending'`,
  )
    .bind(
      now,
      args.moneriumOrderId,
      args.forwardId,
      args.forwardTxHash,
      args.amountReceivedCents,
      sid,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export interface ListIntentsFilter {
  limit?: number;
  offset?: number;
  state?: 'pending' | 'paid' | 'expired';
  sid?: string;
  targetAddress?: string;
}

export async function listIntents(
  env: Env,
  filter: ListIntentsFilter = {},
): Promise<{ items: PaymentIntentRow[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.state) { where.push('state = ?'); args.push(filter.state); }
  if (filter.sid) { where.push('sid LIKE ?'); args.push(`%${filter.sid}%`); }
  if (filter.targetAddress) {
    where.push('target_address = ?');
    args.push(filter.targetAddress.toLowerCase());
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM payment_intents ${whereSql}`,
  ).bind(...args).first<{ c: number }>();
  const itemsRes = await env.DB.prepare(
    `SELECT * FROM payment_intents ${whereSql}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...args, limit, offset).all<PaymentIntentRow>();
  return { items: itemsRes.results, total: totalRow?.c ?? 0 };
}

/// Cron-driven sweep: flip overdue pending intents to expired. Idempotent.
/// Returns number of intents flipped.
export async function sweepExpiredIntents(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE payment_intents
        SET state = 'expired'
      WHERE state = 'pending'
        AND expires_at < ?`,
  )
    .bind(Math.floor(Date.now() / 1000))
    .run();
  return (res.meta?.changes ?? 0) as number;
}

/// Find intent matching a Monerium order via the sid extracted from memo.
/// Returns null if either sid was empty or no intent exists for it.
export async function findIntentBySid(
  env: Env,
  sid: string | null,
): Promise<PaymentIntentRow | null> {
  if (!sid) return null;
  return getIntent(env, sid);
}
