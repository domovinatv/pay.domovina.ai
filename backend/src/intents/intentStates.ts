/// The payment-intent state machine. `payment_intents.state` has three values
/// (pending / paid / expired); together with `monerium_order_id` and `paid_at`
/// they encode six logical states. Every write in ./db.ts is a guarded UPDATE
/// whose WHERE clause is exactly the from-state of one edge below —
/// test/stateMachines.test.ts runs each write against every state and checks
/// that it applies only on the edges of this table. docs/state-machines.md is
/// generated from it.

import type { PaymentIntentRow } from './db';

export type IntentState =
  | 'open'              // pending, no settlement yet
  | 'underpaid'         // pending, settled for LESS than asked (BW-01), merchant decides
  | 'paid'              // settled for the full amount
  | 'expired'           // TTL passed, nothing arrived
  | 'late'              // expired, then settled anyway (money reached the recipient)
  | 'underpaid_expired'; // underpaid, then the TTL passed

export const INTENT_STATES: Record<IntentState, { terminal: boolean; note: string }> = {
  open: { terminal: false, note: 'čeka uplatu' },
  underpaid: { terminal: false, note: 'stiglo manje od traženog' },
  paid: { terminal: true, note: 'plaćeno u cijelosti' },
  expired: { terminal: false, note: 'isteklo bez uplate' },
  late: { terminal: true, note: 'stiglo nakon isteka' },
  underpaid_expired: { terminal: true, note: 'manje od traženog, pa isteklo' },
};

export type IntentEvent =
  | 'settle_full'    // markIntentPaid: amount ≥ intent amount
  | 'settle_short'   // markIntentUnderpaid: amount < intent amount
  | 'settle_late'    // markIntentLate: any amount on an expired intent
  | 'ttl_sweep';     // sweepExpiredIntents

export const INTENT_TRANSITIONS: Array<{ from: IntentState; event: IntentEvent; to: IntentState }> = [
  { from: 'open', event: 'settle_full', to: 'paid' },
  { from: 'underpaid', event: 'settle_full', to: 'paid' },
  { from: 'open', event: 'settle_short', to: 'underpaid' },
  { from: 'open', event: 'ttl_sweep', to: 'expired' },
  { from: 'underpaid', event: 'ttl_sweep', to: 'underpaid_expired' },
  { from: 'expired', event: 'settle_late', to: 'late' },
];

export function logicalIntentState(
  row: Pick<PaymentIntentRow, 'state' | 'monerium_order_id' | 'paid_at'>,
): IntentState {
  if (row.state === 'paid') return 'paid';
  if (row.state === 'expired') {
    if (!row.monerium_order_id) return 'expired';
    return row.paid_at ? 'late' : 'underpaid_expired';
  }
  return row.monerium_order_id ? 'underpaid' : 'open';
}

export function intentMermaid(): string {
  const lines = ['stateDiagram-v2', '  direction LR', '  [*] --> open: POST /api/intents'];
  for (const t of INTENT_TRANSITIONS) lines.push(`  ${t.from} --> ${t.to}: ${t.event}`);
  for (const [s, info] of Object.entries(INTENT_STATES)) if (info.terminal) lines.push(`  ${s} --> [*]`);
  return lines.join('\n');
}
