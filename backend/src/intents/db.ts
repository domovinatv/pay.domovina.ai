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
  /// Migration 0029 (ADR 0024 D6): where the checkout sends the buyer back.
  /// Absent on rows read by older code paths/tests.
  return_url?: string | null;
  /// Migration 0031 (ADR 0028): short reference the payer may type instead
  /// of the memo. Null when allocation failed; absent on older rows/tests.
  short_ref?: string | null;
  /// Migration 0035: inflow provider ('monerium' | 'swan'); NULL on older
  /// rows = Monerium. Read it through inflow/provider.ts intentProvider().
  provider?: string | null;
  /// `intent_settlements.settlement_ref` (ADR 0032 §4), read by getIntent.
  /// A fiat settlement (S3) leaves `monerium_order_id` NULL and this is the
  /// only "settled" signal on the loaded row. Absent on rows read by other
  /// queries/tests.
  settlement_ref?: string | null;
}

/// Settled on the loaded row: a settlement or (legacy rows / fixtures) a
/// Monerium order. The SQL counterpart is settledSql().
export function isSettled(row: { monerium_order_id?: string | null; settlement_ref?: string | null }): boolean {
  return Boolean(row.monerium_order_id || row.settlement_ref);
}

/// The order/settlement id merchants see as `monerium_order_id` (intent.paid
/// payload, GET /intents/:sid). For a fiat intent it is the settlement ref
/// (`swan_<txId>`), the same value the synthetic order carried before S3.
export function settlementId(row: { monerium_order_id?: string | null; settlement_ref?: string | null }): string | null {
  return row.monerium_order_id ?? row.settlement_ref ?? null;
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
  /// ADR 0024 D6, validated by the caller (secret key only).
  returnUrl?: string | null;
  /// Migration 0035; omitted = 'monerium'.
  provider?: string;
}

export async function createIntent(
  env: Env,
  args: CreateIntentArgs,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO payment_intents
       (sid, target_address, amount_cents, currency, label, metadata_json,
        state, created_at, expires_at, tenant_id, created_with_key, return_url, provider)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
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
      args.returnUrl ?? null,
      args.provider ?? 'monerium',
    )
    .run();
}

/// SQL: is intent `i` a trusted stray / reroute candidate (SR-01)? Binds one
/// parameter: the default tenant id (for NULL tenant_id rows).
export const TRUSTED_CANDIDATE_SQL = `(i.created_with_key = 1
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
    `SELECT *, (SELECT s.settlement_ref FROM intent_settlements s WHERE s.sid = payment_intents.sid) AS settlement_ref
       FROM payment_intents WHERE sid = ?`,
  )
    .bind(sid)
    .first<PaymentIntentRow>();
  return row ?? null;
}

/// Provider of a settlement, read off its order id: synthetic fiat orders
/// carry `<provider>_` (inflow/settleFiat.ts), sandbox ones `sim_`.
export function settlementProvider(orderId: string): string {
  if (orderId.startsWith('swan_')) return 'swan';
  if (orderId.startsWith('sim_')) return 'sandbox';
  return 'monerium';
}

/// „Intent je namiren”: ima red u `intent_settlements` (ADR 0032 §4) ili, za
/// redove iz vremena prije 0036 / fixtureove, `monerium_order_id`. Dok se oboje
/// piše u istom batchu (runSettlementClaim) to je isto; S3 (fiat bez sintetskog
/// ordera) ostavlja `monerium_order_id` NULL pa je red u `intent_settlements`
/// jedini signal. `alias` = tablica/alias za payment_intents u upitu.
export function settledSql(alias: string): string {
  return `(${alias}.monerium_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM intent_settlements s WHERE s.sid = ${alias}.sid))`;
}

/// Arguments every settle claim takes. A Monerium settlement names its order
/// (`moneriumOrderId`) and forward. A fiat settlement (S3, ADR 0032 §4) has
/// neither: `moneriumOrderId` and `forwardId` are NULL and `settlementRef`
/// (`<provider>_<txId>`) names the payment.
export interface SettleArgs {
  moneriumOrderId: string | null;
  forwardId: number | null;
  forwardTxHash: string | null;
  amountReceivedCents: number | null;
  settlementRef?: string | null;
}

function settleRef(args: SettleArgs): string {
  const ref = args.moneriumOrderId ?? args.settlementRef;
  if (!ref) throw new Error('settle_without_ref');
  return ref;
}

/// ADR 0032 §4: the settlement row is written in the SAME D1 transaction as
/// the intent's claim, and only when the claim actually landed. For an order
/// the SELECT re-reads the row the UPDATE just wrote. Upsert because a
/// `pending` underpaid intent can still flip `paid` on a later order, which
/// rewrites `monerium_order_id` too.
///
/// Without an order (fiat, S3) there is nothing on the intent to re-read, so
/// the INSERT is conditional on `changes()` of the claim, the previous
/// statement of the same batch transaction.
async function runSettlementClaim(
  env: Env,
  claim: D1PreparedStatement,
  sid: string,
  args: SettleArgs,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const orderId = args.moneriumOrderId;
  const ref = settleRef(args);
  const onConflict = `ON CONFLICT (sid) DO UPDATE SET
       provider = excluded.provider,
       settlement_ref = excluded.settlement_ref,
       credit_event_id = excluded.credit_event_id
     WHERE intent_settlements.settlement_ref <> excluded.settlement_ref`;
  const link = orderId
    ? env.DB.prepare(
        `INSERT INTO intent_settlements (sid, provider, settlement_ref, credit_event_id, created_at)
         SELECT i.sid, ?, i.monerium_order_id,
                (SELECT ce.id FROM credit_events ce WHERE ce.settlement_ref = i.monerium_order_id
                  ORDER BY ce.id DESC LIMIT 1),
                ?
           FROM payment_intents i
          WHERE i.sid = ? AND i.monerium_order_id = ?
         ${onConflict}`,
      ).bind(settlementProvider(orderId), now, sid, orderId)
    : env.DB.prepare(
        `INSERT INTO intent_settlements (sid, provider, settlement_ref, credit_event_id, created_at)
         SELECT ?, ?, ?,
                (SELECT ce.id FROM credit_events ce WHERE ce.settlement_ref = ?
                  ORDER BY ce.id DESC LIMIT 1),
                ?
          WHERE changes() > 0
         ${onConflict}`,
      ).bind(sid, settlementProvider(ref), ref, ref, now);
  const [res] = await env.DB.batch([claim, link]);
  return (res.meta?.changes ?? 0) > 0;
}

/// Idempotently mark an intent paid. Only transitions `pending → paid`
/// — already-paid or expired intents are left untouched so we never
/// overwrite earlier (correct) settlement data with later (orphan)
/// webhook retries.
export async function markIntentPaid(
  env: Env,
  sid: string,
  args: SettleArgs,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const claim = env.DB.prepare(
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
  return runSettlementClaim(env, claim, sid, args);
}

/// Settlement for LESS than the intent asked for (BW-01). The money did reach
/// the recipient (the forward does not look at the intent amount), so the
/// settlement data is recorded, but the intent stays `pending` — the merchant
/// gets `payment.underpaid` and decides. No paid_at. Single-fire: only the
/// first caller sees true (not yet settledSql; the
/// claim runs before the batch's settlement INSERT, so it sees the old state).
export async function markIntentUnderpaid(
  env: Env,
  sid: string,
  args: SettleArgs,
): Promise<boolean> {
  const claim = env.DB.prepare(
    `UPDATE payment_intents
        SET monerium_order_id = ?,
            forward_id = ?,
            forward_tx_hash = ?,
            amount_received_cents = ?
      WHERE sid = ?
        AND state = 'pending'
        AND NOT ${settledSql('payment_intents')}
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
  return runSettlementClaim(env, claim, sid, args);
}

/// Settlement landed on an intent that had already EXPIRED. The state stays
/// 'expired' (expiry is final for the intent), but the settlement data is
/// recorded so the status timeline and admin can show where the money went.
/// Single-fire: only the first caller sees true (not yet settledSql; the
/// claim runs before the batch's settlement INSERT, so it sees the old state).
export async function markIntentLate(
  env: Env,
  sid: string,
  args: SettleArgs,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const claim = env.DB.prepare(
    `UPDATE payment_intents
        SET paid_at = ?,
            monerium_order_id = ?,
            forward_id = ?,
            forward_tx_hash = ?,
            amount_received_cents = ?
      WHERE sid = ?
        AND state = 'expired'
        AND NOT ${settledSql('payment_intents')}`,
  )
    .bind(
      now,
      args.moneriumOrderId,
      args.forwardId,
      args.forwardTxHash,
      args.amountReceivedCents,
      sid,
    )
  return runSettlementClaim(env, claim, sid, args);
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
        AND i.state IN ('pending', 'expired') AND NOT ${settledSql('i')}
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
        AND i.state IN ('pending', 'expired') AND NOT ${settledSql('i')}
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
