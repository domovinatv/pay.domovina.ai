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
        AND state = 'pending'
        AND ? IS NOT NULL AND ? >= amount_cents`,
  )
    .bind(
      now,
      args.moneriumOrderId,
      args.forwardId,
      args.forwardTxHash,
      args.amountReceivedCents,
      sid,
      // BW-01: less than the intent asked for never flips `paid`.
      args.amountReceivedCents,
      args.amountReceivedCents,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/// Settlement for LESS than the intent asked for (BW-01). The money did reach
/// the recipient (the forward does not look at the intent amount), so the
/// settlement data is recorded, but the intent stays `pending` — the merchant
/// gets `payment.underpaid` and decides. No paid_at. Single-fire: only the
/// first caller sees true (monerium_order_id IS NULL).
export async function markIntentUnderpaid(
  env: Env,
  sid: string,
  args: {
    moneriumOrderId: string;
    forwardId: number;
    forwardTxHash: string | null;
    amountReceivedCents: number | null;
  },
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE payment_intents
        SET monerium_order_id = ?,
            forward_id = ?,
            forward_tx_hash = ?,
            amount_received_cents = ?
      WHERE sid = ?
        AND state = 'pending'
        AND monerium_order_id IS NULL
        AND (? IS NULL OR ? < amount_cents)`,
  )
    .bind(
      args.moneriumOrderId,
      args.forwardId,
      args.forwardTxHash,
      args.amountReceivedCents,
      sid,
      args.amountReceivedCents,
      args.amountReceivedCents,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/// Settlement landed on an intent that had already EXPIRED. The state stays
/// 'expired' (expiry is final for the intent), but the settlement data is
/// recorded so the status timeline and admin can show where the money went.
/// Single-fire: only the first caller sees true (monerium_order_id IS NULL).
export async function markIntentLate(
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
        SET paid_at = ?,
            monerium_order_id = ?,
            forward_id = ?,
            forward_tx_hash = ?,
            amount_received_cents = ?
      WHERE sid = ?
        AND state = 'expired'
        AND monerium_order_id IS NULL`,
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
  /// Tenant filter; NULL tenant_id rows count as the default tenant.
  tenant?: { sql: string; args: unknown[] };
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
  if (filter.tenant) { where.push(filter.tenant.sql); args.push(...filter.tenant.args); }
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
/// Returns the sids that flipped, so their SSE streams can be told.
export async function sweepExpiredIntents(env: Env): Promise<string[]> {
  const res = await env.DB.prepare(
    `UPDATE payment_intents
        SET state = 'expired'
      WHERE state = 'pending'
        AND expires_at < ?
      RETURNING sid`,
  )
    .bind(Math.floor(Date.now() / 1000))
    .all<{ sid: string }>();
  return res.results.map((r) => r.sid);
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

/// Intents a reference-less payment could have paid (stray resolver,
/// ../monerium/strayResolver.ts): same tenant, exact amount, created inside
/// the look-back window, not yet settled and not already claimed by a live
/// forward. Intents from before tenants existed (tenant_id NULL) count as the
/// default tenant's, exactly like the forward gate treats them.
export async function findStrayCandidates(
  env: Env,
  args: {
    tenantId: string;
    defaultTenantId: string;
    amountCents: number;
    createdFrom: number;
    createdTo: number;
  },
): Promise<Array<Pick<PaymentIntentRow, 'sid' | 'target_address' | 'state' | 'created_at' | 'expires_at'>>> {
  const res = await env.DB.prepare(
    `SELECT i.sid, i.target_address, i.state, i.created_at, i.expires_at
       FROM payment_intents i
      WHERE COALESCE(i.tenant_id, ?) = ?
        AND i.amount_cents = ?
        AND i.created_at BETWEEN ? AND ?
        AND (i.state = 'pending' OR (i.state = 'expired' AND i.monerium_order_id IS NULL))
        AND NOT EXISTS (
          SELECT 1 FROM monerium_forwards f
           WHERE f.sid = i.sid
             AND f.status IN ('pending', 'submitted', 'confirmed'))
      ORDER BY i.created_at DESC
      LIMIT 20`,
  )
    .bind(args.defaultTenantId, args.tenantId, args.amountCents, args.createdFrom, args.createdTo)
    .all<Pick<PaymentIntentRow, 'sid' | 'target_address' | 'state' | 'created_at' | 'expires_at'>>();
  return res.results;
}

/// Admin reroute picker: unsettled intents of one tenant created in a window
/// around a parked payment, ANY amount — the operator may know the payer
/// typed a wrong sum. Exact-amount matches sort first, then newest.
export async function listRerouteCandidates(
  env: Env,
  args: {
    tenantId: string;
    defaultTenantId: string;
    amountCents: number;
    createdFrom: number;
    createdTo: number;
  },
): Promise<Array<Pick<PaymentIntentRow, 'sid' | 'target_address' | 'amount_cents' | 'state' | 'created_at' | 'expires_at' | 'label'>>> {
  const res = await env.DB.prepare(
    `SELECT i.sid, i.target_address, i.amount_cents, i.state, i.created_at, i.expires_at, i.label
       FROM payment_intents i
      WHERE COALESCE(i.tenant_id, ?) = ?
        AND i.created_at BETWEEN ? AND ?
        AND i.state IN ('pending', 'expired') AND i.monerium_order_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM monerium_forwards f
           WHERE f.sid = i.sid
             AND f.status IN ('pending', 'submitted', 'confirmed'))
      ORDER BY (i.amount_cents = ?) DESC, i.created_at DESC
      LIMIT 30`,
  )
    .bind(args.defaultTenantId, args.tenantId, args.createdFrom, args.createdTo, args.amountCents)
    .all<Pick<PaymentIntentRow, 'sid' | 'target_address' | 'amount_cents' | 'state' | 'created_at' | 'expires_at' | 'label'>>();
  return res.results;
}
