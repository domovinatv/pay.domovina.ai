import type { Env } from '../types';
import type { PaymentIntentRow } from './db';

/// Merchant-facing intent listing (ADR 0024 D8): one tenant's intents, newest
/// first, keyset-paginated so a page never shifts under concurrent inserts.
/// Rows created before tenants existed (tenant_id NULL) belong to the default
/// tenant, exactly as everywhere else.

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

export type IntentStateFilter = 'pending' | 'paid' | 'expired';

export interface TenantIntentQuery {
  tenantId: string;
  /// The default tenant also owns rows with tenant_id NULL.
  includeLegacyNull: boolean;
  state: IntentStateFilter | null;
  /// Unix seconds, inclusive / exclusive, on created_at.
  createdFrom: number | null;
  createdTo: number | null;
  limit: number;
  cursor: { createdAt: number; sid: string } | null;
}

export function encodeCursor(row: Pick<PaymentIntentRow, 'created_at' | 'sid'>): string {
  return btoa(`${row.created_at}:${row.sid}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(raw: string): { createdAt: number; sid: string } | null {
  try {
    const s = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const m = s.match(/^(\d{1,12}):([A-Za-z0-9_-]{6,32})$/);
    return m ? { createdAt: Number(m[1]), sid: m[2] } : null;
  } catch {
    return null;
  }
}

function tenantWhere(q: Pick<TenantIntentQuery, 'tenantId' | 'includeLegacyNull'>): { sql: string; args: unknown[] } {
  return q.includeLegacyNull
    ? { sql: '(tenant_id = ? OR tenant_id IS NULL)', args: [q.tenantId] }
    : { sql: 'tenant_id = ?', args: [q.tenantId] };
}

function rangeWhere(q: Pick<TenantIntentQuery, 'createdFrom' | 'createdTo'>, where: string[], args: unknown[]): void {
  if (q.createdFrom !== null) { where.push('created_at >= ?'); args.push(q.createdFrom); }
  if (q.createdTo !== null) { where.push('created_at < ?'); args.push(q.createdTo); }
}

export async function listTenantIntents(
  env: Env,
  q: TenantIntentQuery,
): Promise<{ items: PaymentIntentRow[]; nextCursor: string | null }> {
  const t = tenantWhere(q);
  const where = [t.sql];
  const args: unknown[] = [...t.args];
  if (q.state) { where.push('state = ?'); args.push(q.state); }
  rangeWhere(q, where, args);
  if (q.cursor) {
    where.push('(created_at < ? OR (created_at = ? AND sid < ?))');
    args.push(q.cursor.createdAt, q.cursor.createdAt, q.cursor.sid);
  }
  // One extra row tells whether there is a next page.
  const res = await env.DB.prepare(
    `SELECT * FROM payment_intents WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, sid DESC LIMIT ?`,
  )
    .bind(...args, q.limit + 1)
    .all<PaymentIntentRow>();
  const rows = res.results;
  const more = rows.length > q.limit;
  const items = more ? rows.slice(0, q.limit) : rows;
  return { items, nextCursor: more ? encodeCursor(items[items.length - 1]) : null };
}

export interface IntentBucket {
  count: number;
  /// What the intents asked for.
  amount_cents: number;
  /// What actually settled (null-safe sum; 0 when nothing settled).
  amount_received_cents: number;
}

/// Revenue-shaped totals, one bucket per outcome a merchant cares about:
///   paid      — state paid (counts as revenue)
///   late      — settled after expiry (`payment.late`; revenue if you credit it)
///   underpaid — settled for less, still pending (`payment.underpaid`)
///   pending   — waiting for money
///   expired   — expired without money
export interface IntentStats {
  paid: IntentBucket;
  late: IntentBucket;
  underpaid: IntentBucket;
  pending: IntentBucket;
  expired: IntentBucket;
}

export async function tenantIntentStats(
  env: Env,
  q: Pick<TenantIntentQuery, 'tenantId' | 'includeLegacyNull' | 'createdFrom' | 'createdTo'>,
): Promise<IntentStats> {
  const t = tenantWhere(q);
  const where = [t.sql];
  const args: unknown[] = [...t.args];
  rangeWhere(q, where, args);
  const res = await env.DB.prepare(
    `SELECT CASE
              WHEN state = 'paid' THEN 'paid'
              WHEN state = 'expired' AND monerium_order_id IS NOT NULL THEN 'late'
              WHEN state = 'expired' THEN 'expired'
              WHEN monerium_order_id IS NOT NULL THEN 'underpaid'
              ELSE 'pending'
            END AS bucket,
            COUNT(*) AS count,
            COALESCE(SUM(amount_cents), 0) AS amount_cents,
            COALESCE(SUM(amount_received_cents), 0) AS amount_received_cents
       FROM payment_intents WHERE ${where.join(' AND ')}
      GROUP BY bucket`,
  )
    .bind(...args)
    .all<{ bucket: keyof IntentStats } & IntentBucket>();
  const empty = (): IntentBucket => ({ count: 0, amount_cents: 0, amount_received_cents: 0 });
  const stats: IntentStats = { paid: empty(), late: empty(), underpaid: empty(), pending: empty(), expired: empty() };
  for (const r of res.results) {
    stats[r.bucket] = { count: r.count, amount_cents: r.amount_cents, amount_received_cents: r.amount_received_cents };
  }
  return stats;
}
