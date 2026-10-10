import type { Env } from '../types';

export interface PaymentIntentRow {
  /// Migration 0022 (SR-01). Absent on rows read by older code paths/tests.
  created_with_key?: number;
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
  /// Created with the tenant's SECRET key (SR-01) — a trusted stray candidate.
  createdWithKey?: boolean;
}

export async function createIntent(
  env: Env,
  args: CreateIntentArgs,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO payment_intents
       (sid, target_address, amount_cents, currency, label, metadata_json,
        state, created_at, expires_at, tenant_id, created_with_key)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
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
      args.createdWithKey ? 1 : 0,
    )
    .run();
}

/// SQL: is intent `i` a trusted stray / reroute candidate (SR-01)? Binds one
/// parameter: the default tenant id (for NULL tenant_id rows).
const TRUSTED_CANDIDATE_SQL = `(i.created_with_key = 1
          OR EXISTS (SELECT 1 FROM tenant_payout_addresses p
                      WHERE p.tenant_id = COALESCE(i.tenant_id, ?)
                        AND lower(p.address) = lower(i.target_address)
                        AND p.revoked_at IS NULL
                        AND p.source IN ('admin', 'seed')))`;

/// Open intents to one destination (SR-01 cap). Pending and not expired yet.
export async function countOpenIntentsForTarget(
  env: Env,
  tenantId: string,
  target: string,
  nowUnix: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM payment_intents
      WHERE tenant_id = ? AND target_address = ? AND state = 'pending' AND expires_at > ?`,
  )
    .bind(tenantId, target.toLowerCase(), nowUnix)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/// Is `target` on the tenant's STATIC whitelist as a trusted destination
/// (admin / non-wallet seed)? Same rule as TRUSTED_CANDIDATE_SQL.
export async function isTrustedTarget(env: Env, tenantId: string, target: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM tenant_payout_addresses
      WHERE tenant_id = ? AND lower(address) = ? AND revoked_at IS NULL AND source IN ('admin', 'seed')`,
  )
    .bind(tenantId, target.toLowerCase())
    .first<{ ok: number }>();
  return row !== null;
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
): Promise<Array<Pick<PaymentIntentRow, 'sid' | 'target_address' | 'state' | 'created_at' | 'expires_at'> & { trusted: boolean }>> {
  const res = await env.DB.prepare(
    `SELECT i.sid, i.target_address, i.state, i.created_at, i.expires_at,
            ${TRUSTED_CANDIDATE_SQL} AS trusted
       FROM payment_intents i
      WHERE COALESCE(i.tenant_id, ?) = ?
        AND i.amount_cents = ?
        AND i.created_at BETWEEN ? AND ?
        AND i.state IN ('pending', 'expired') AND i.monerium_order_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM monerium_forwards f
           WHERE f.sid = i.sid
             AND f.status IN ('pending', 'submitted', 'confirmed'))
      ORDER BY i.created_at DESC
      LIMIT ${STRAY_CANDIDATE_LIMIT}`,
  )
    .bind(args.defaultTenantId, args.defaultTenantId, args.tenantId, args.amountCents, args.createdFrom, args.createdTo)
    .all<Pick<PaymentIntentRow, 'sid' | 'target_address' | 'state' | 'created_at' | 'expires_at'> & { trusted: number }>();
  // SR-04: a full page means the window was flooded — say so, the decision
  // may be missing candidates.
  if (res.results.length >= STRAY_CANDIDATE_LIMIT) {
    console.warn(`stray candidates hit LIMIT ${STRAY_CANDIDATE_LIMIT} (tenant ${args.tenantId}, ${args.amountCents} c)`);
  }
  return res.results.map((r) => ({ ...r, trusted: r.trusted === 1 }));
}

const STRAY_CANDIDATE_LIMIT = 200;

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
): Promise<Array<Pick<PaymentIntentRow, 'sid' | 'target_address' | 'amount_cents' | 'state' | 'created_at' | 'expires_at' | 'label'> & { trusted: boolean }>> {
  const res = await env.DB.prepare(
    `SELECT i.sid, i.target_address, i.amount_cents, i.state, i.created_at, i.expires_at, i.label,
            ${TRUSTED_CANDIDATE_SQL} AS trusted
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
    .bind(args.defaultTenantId, args.defaultTenantId, args.tenantId, args.createdFrom, args.createdTo, args.amountCents)
    .all<Pick<PaymentIntentRow, 'sid' | 'target_address' | 'amount_cents' | 'state' | 'created_at' | 'expires_at' | 'label'> & { trusted: number }>();
  return res.results.map((r) => ({ ...r, trusted: r.trusted === 1 }));
}
