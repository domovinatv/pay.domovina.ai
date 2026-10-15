/// The forward state machine — the ONE place that says which states a
/// `monerium_forwards` row can be in and how it may move between them.
/// docs/state-machines.md is generated from this file (test/stateMachines.test.ts
/// fails when the document is stale).
///
/// A row is one attempt for one Monerium order. It is created in a state,
/// moves along at most two edges, and ends in a terminal state. A terminal
/// row is never revived: retry, reroute and off-rail resolution each INSERT a
/// new row for the same order (the live latch, migration 0016, allows that
/// only while no row of the order is live).
///
/// The DB keeps two columns: `status` (pending/submitted/confirmed/failed/
/// blocked/resolved_offrail) and `error`. Some logical states share a status
/// and differ only in `error` — `logicalForwardState` is the mapping, and
/// every transition's SQL guard is built from it, so a row can only move out
/// of exactly the logical state the table names.

import type { MoneriumForwardRow } from './db';

export type ForwardDbStatus = MoneriumForwardRow['status'];

export type ForwardState =
  | 'broadcasting'     // authorised; the rail is about to send / sending the tx
  | 'owed'             // direct mode D4: money in the main Safe, 2/3 owners must move it
  | 'submitted'        // tx broadcast (or owners' tx seen), receipt not yet final
  | 'forwarded'        // tx confirmed on-chain — intent settled
  | 'settled_noop'     // nothing to move: mint landed at the destination (self_noop, direct_mint)
  | 'contribution'     // direct mode D6: minted straight into a project Safe, no intent
  | 'parked'           // refused by the gate; EURe stays where Monerium minted it
  | 'failed'           // broadcast error, on-chain revert or dropped tx
  | 'resolved_offrail'; // an operator moved the money by hand; verified on-chain

export interface StateInfo {
  /// DB status this state is stored as.
  status: ForwardDbStatus;
  /// Older encodings still present in the table (read, never written).
  legacy?: Array<{ status: ForwardDbStatus; error: string }>;
  /// Errors that select this state within `status` (null = no error). Absent
  /// = every row of `status` not claimed by a sibling state.
  errors?: Array<string | null>;
  terminal: boolean;
  /// One line for the document.
  note: string;
}

export const OWED_ERROR = 'direct_owed';
export const NOOP_ERRORS = ['self_target_noop', 'direct_mint'];
export const CONTRIBUTION_ERROR = 'direct_contribution';
/// Parks predating the whitelist keep status 'failed' (admin filters on it).
export const LEGACY_PARK_ERROR = 'no_routing_target';

export const FORWARD_STATES: Record<ForwardState, StateInfo> = {
  broadcasting: { status: 'pending', terminal: false, note: 'gate je pustio, rail šalje tx' },
  owed: { status: 'pending', errors: [OWED_ERROR], terminal: false, note: 'direct D4: čeka ručni 2/3 prijenos' },
  submitted: { status: 'submitted', terminal: false, note: 'tx poslan, čeka potvrdu' },
  forwarded: { status: 'confirmed', terminal: true, note: 'tx potvrđen, intent plaćen' },
  settled_noop: { status: 'confirmed', errors: NOOP_ERRORS, terminal: true, note: 'mint je već na odredištu' },
  contribution: { status: 'confirmed', errors: [CONTRIBUTION_ERROR], terminal: true, note: 'direct D6: doprinos projektu' },
  parked: {
    status: 'blocked',
    // A gate park with no address at all keeps status 'failed' (admin filters on it).
    legacy: [{ status: 'failed', error: LEGACY_PARK_ERROR }],
    terminal: true,
    note: 'gate odbio, novac stoji, alarm',
  },
  failed: { status: 'failed', terminal: true, note: 'broadcast/revert/dropped, može retry' },
  resolved_offrail: { status: 'resolved_offrail', terminal: true, note: 'operater ručno, provjereno on-chain' },
};

/// How a row is born (handleForward, park, markResolvedOffRail).
export type ForwardCreation =
  | 'authorised'      // gate: forward
  | 'direct_owed'     // gate: direct_owed (D4)
  | 'noop'            // gate: self_noop / direct_settle
  | 'contribution'    // gate: direct_contribution (D6)
  | 'park'            // gate: park (incl. legacy no_routing_target → status failed)
  | 'offrail';        // operator: resolved_offrail

export const CREATIONS: Record<ForwardCreation, ForwardState> = {
  authorised: 'broadcasting',
  direct_owed: 'owed',
  noop: 'settled_noop',
  contribution: 'contribution',
  park: 'parked',
  offrail: 'resolved_offrail',
};

export type ForwardEvent =
  | 'broadcast_ok'
  | 'broadcast_failed'
  | 'owners_transfer'   // outflow watcher saw the owed transfer (D4)
  | 'router_claim'      // ADR 0026: ProjectRouter simulated OK and takes the owed row before broadcasting
  | 'receipt_confirmed'
  | 'receipt_failed';   // revert, or dropped from every mempool

export interface Transition {
  from: ForwardState;
  event: ForwardEvent;
  to: ForwardState;
}

/// Every edge a row may take. Anything else is refused by the SQL guard.
export const FORWARD_TRANSITIONS: Transition[] = [
  { from: 'broadcasting', event: 'broadcast_ok', to: 'submitted' },
  { from: 'broadcasting', event: 'broadcast_failed', to: 'failed' },
  { from: 'owed', event: 'owners_transfer', to: 'submitted' },
  { from: 'owed', event: 'router_claim', to: 'broadcasting' },
  { from: 'submitted', event: 'receipt_confirmed', to: 'forwarded' },
  { from: 'submitted', event: 'receipt_failed', to: 'failed' },
];

/// Order-level follow-ups: not an edge of the row, a NEW row for the order.
export const FOLLOW_UPS: Array<{ from: ForwardState; action: string; creates: ForwardCreation }> = [
  { from: 'failed', action: 'admin retry', creates: 'authorised' },
  { from: 'parked', action: 'admin reroute', creates: 'authorised' },
  { from: 'parked', action: 'admin reroute (direct)', creates: 'direct_owed' },
  { from: 'parked', action: 'resolved_offrail', creates: 'offrail' },
  { from: 'failed', action: 'resolved_offrail', creates: 'offrail' },
];

/// Logical state of a stored row. Unknown combinations map to the plain
/// state of their status (the `errors`-less sibling).
export function logicalForwardState(row: Pick<MoneriumForwardRow, 'status' | 'error'>): ForwardState {
  switch (row.status) {
    case 'pending': return row.error === OWED_ERROR ? 'owed' : 'broadcasting';
    case 'submitted': return 'submitted';
    case 'confirmed':
      if (row.error && NOOP_ERRORS.includes(row.error)) return 'settled_noop';
      if (row.error === CONTRIBUTION_ERROR) return 'contribution';
      return 'forwarded';
    case 'blocked': return 'parked';
    case 'failed': return row.error === LEGACY_PARK_ERROR ? 'parked' : 'failed';
    case 'resolved_offrail': return 'resolved_offrail';
  }
}

/// SQL predicate (over `status`, `error`) that holds exactly for rows in `s`.
export function stateSql(s: ForwardState): string {
  switch (s) {
    case 'broadcasting': return `status = 'pending' AND COALESCE(error, '') <> '${OWED_ERROR}'`;
    case 'owed': return `status = 'pending' AND error = '${OWED_ERROR}'`;
    case 'submitted': return `status = 'submitted'`;
    case 'forwarded':
      return `status = 'confirmed' AND COALESCE(error, '') NOT IN (${[...NOOP_ERRORS, CONTRIBUTION_ERROR].map((e) => `'${e}'`).join(', ')})`;
    case 'settled_noop': return `status = 'confirmed' AND error IN (${NOOP_ERRORS.map((e) => `'${e}'`).join(', ')})`;
    case 'contribution': return `status = 'confirmed' AND error = '${CONTRIBUTION_ERROR}'`;
    case 'parked': return `(status = 'blocked' OR (status = 'failed' AND error = '${LEGACY_PARK_ERROR}'))`;
    case 'failed': return `status = 'failed' AND COALESCE(error, '') <> '${LEGACY_PARK_ERROR}'`;
    case 'resolved_offrail': return `status = 'resolved_offrail'`;
  }
}

export function transitionFor(event: ForwardEvent): Transition {
  const t = FORWARD_TRANSITIONS.find((x) => x.event === event);
  if (!t) throw new Error(`unknown forward event ${event}`);
  return t;
}

export class IllegalForwardTransition extends Error {}

/// Which event a legacy `updateForward(id, { status })` call means. The two
/// callers (handleForward after broadcast) only ever leave `broadcasting`.
export function eventForStatusPatch(to: ForwardDbStatus): ForwardEvent {
  if (to === 'submitted') return 'broadcast_ok';
  if (to === 'failed') return 'broadcast_failed';
  throw new IllegalForwardTransition(`updateForward cannot set status ${to}; use a forward event`);
}

/// Mermaid stateDiagram-v2 of the table above (embedded in docs/state-machines.md).
export function forwardMermaid(): string {
  const lines = ['stateDiagram-v2', '  direction LR'];
  for (const [s, info] of Object.entries(FORWARD_STATES)) {
    const stored = `${info.status}${info.errors ? ` · ${info.errors.join(' / ')}` : ''}`;
    const legacy = (info.legacy ?? []).map((l) => ` | ${l.status} · ${l.error}`).join('');
    lines.push(`  state "${s} (${stored}${legacy})" as ${s}`);
  }
  for (const [c, s] of Object.entries(CREATIONS)) lines.push(`  [*] --> ${s}: ${c}`);
  for (const t of FORWARD_TRANSITIONS) lines.push(`  ${t.from} --> ${t.to}: ${t.event}`);
  for (const [s, info] of Object.entries(FORWARD_STATES)) if (info.terminal) lines.push(`  ${s} --> [*]`);
  return lines.join('\n');
}
