import type { MoneriumOrder } from './types';

/// Monerium order lifecycle: placed → pending → processed | rejected.
/// Webhooks can arrive out of order (Monerium retries a failed delivery for up
/// to 12 h), so a stored order must never move backwards: a late
/// `order.created` (pending) must not overwrite an already `processed` row and
/// wipe its processedAt / txHashes.
export const ORDER_STATE_RANK: Record<string, number> = {
  placed: 1,
  pending: 2,
  processed: 3,
  rejected: 3,
};

export function orderStateRank(state: string | null | undefined): number {
  return (state && ORDER_STATE_RANK[state]) || 0;
}

/// Same ranking as a SQL expression, for the monotonic upsert guard.
export function orderStateRankSql(column: string): string {
  return `(CASE ${column} WHEN 'placed' THEN 1 WHEN 'pending' THEN 2 ` +
    `WHEN 'processed' THEN 3 WHEN 'rejected' THEN 3 ELSE 0 END)`;
}

export function orderState(order: MoneriumOrder): string {
  return order.state ?? order.meta?.state ?? 'placed';
}

/// Monerium's decimal-string amount ("12.34") → integer minor units.
export function parseAmountCentsFromOrder(order: MoneriumOrder): number | null {
  if (!order.amount) return null;
  const n = Number(order.amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/// Monerium formats IBANs with spaces ("LT55 3250 0134 …").
export function normalizeIban(iban: string | null | undefined): string | null {
  if (!iban) return null;
  const s = iban.replace(/\s+/g, '').toUpperCase();
  return s.length > 0 ? s : null;
}
