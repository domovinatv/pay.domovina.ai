import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { transitionForward, updateForward } from '../src/monerium/db';
import {
  CREATIONS,
  FORWARD_STATES,
  FORWARD_TRANSITIONS,
  FOLLOW_UPS,
  forwardMermaid,
  IllegalForwardTransition,
  logicalForwardState,
  stateSql,
  type ForwardEvent,
  type ForwardState,
} from '../src/monerium/forwardStates';
import {
  INTENT_STATES,
  INTENT_TRANSITIONS,
  intentMermaid,
  logicalIntentState,
  type IntentEvent,
  type IntentState,
} from '../src/intents/intentStates';
import { markIntentLate, markIntentPaid, markIntentUnderpaid, sweepExpiredIntents } from '../src/intents/db';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// The state machines are the spec (src/monerium/forwardStates.ts,
/// src/intents/intentStates.ts). These tests prove the SQL obeys them for
/// EVERY (state, event) pair — not just the paths other tests walk — and that
/// docs/state-machines.md still shows exactly these tables.

/// A stored (status, error) for each logical forward state, plus the
/// variants that share a status.
const FORWARD_SAMPLES: Array<[ForwardState, string, string | null]> = [
  ['broadcasting', 'pending', null],
  ['owed', 'pending', 'direct_owed'],
  ['submitted', 'submitted', null],
  ['forwarded', 'confirmed', null],
  ['settled_noop', 'confirmed', 'self_target_noop'],
  ['settled_noop', 'confirmed', 'direct_mint'],
  ['contribution', 'confirmed', 'direct_contribution'],
  ['parked', 'blocked', 'not_whitelisted:target_mismatch'],
  ['parked', 'failed', 'no_routing_target'],
  ['failed', 'failed', 'onchain_revert'],
  ['failed', 'failed', 'router_disabled: x'],
  ['resolved_offrail', 'resolved_offrail', null],
];
const EVENTS: ForwardEvent[] = ['broadcast_ok', 'broadcast_failed', 'owners_transfer', 'receipt_confirmed', 'receipt_failed'];

function forwardDb() {
  const { db, raw } = migratedD1();
  const env = { DB: db } as unknown as Env;
  let n = 0;
  const seed = (status: string, error: string | null): number => {
    n++;
    const r = raw.prepare(
      `INSERT INTO monerium_forwards (order_id, target_address, amount_wei, status, error, attempts, created_at, updated_at)
       VALUES (?, '0x1', '0', ?, ?, 0, 0, 0)`,
    ).run(`ord-${n}`, status, error);
    return Number(r.lastInsertRowid);
  };
  const read = (id: number) =>
    raw.prepare(`SELECT status, error FROM monerium_forwards WHERE id = ?`).get(id) as { status: string; error: string | null };
  return { env, raw, seed, read };
}

describe('forward state machine', () => {
  it('logicalForwardState and the SQL predicate agree on every sample', () => {
    const { raw, seed } = forwardDb();
    for (const [state, status, error] of FORWARD_SAMPLES) {
      expect(logicalForwardState({ status: status as never, error })).toBe(state);
      const id = seed(status, error);
      for (const s of Object.keys(FORWARD_STATES) as ForwardState[]) {
        const hit = raw.prepare(`SELECT 1 AS x FROM monerium_forwards WHERE id = ? AND ${stateSql(s)}`).get(id);
        expect(Boolean(hit), `${status}/${error} in ${s}`).toBe(s === state);
      }
    }
  });

  it('every stored state is one of FORWARD_STATES and lives in its status', () => {
    for (const [state, status, error] of FORWARD_SAMPLES) {
      const info = FORWARD_STATES[state];
      const ok = info.status === status || (info.legacy ?? []).some((l) => l.status === status && l.error === error);
      expect(ok, `${state} stored as ${status}/${error}`).toBe(true);
    }
  });

  for (const [state, status, error] of FORWARD_SAMPLES) {
    for (const event of EVENTS) {
      const edge = FORWARD_TRANSITIONS.find((t) => t.from === state && t.event === event);
      it(`${state} (${status}/${error ?? '∅'}) + ${event} → ${edge ? edge.to : 'refused'}`, async () => {
        const { env, seed, read } = forwardDb();
        const id = seed(status, error);
        const applied = await transitionForward(env, id, event, { tx_hash: '0xabc' });
        expect(applied).toBe(Boolean(edge));
        const after = read(id);
        expect(logicalForwardState(after as never)).toBe(edge ? edge.to : state);
        if (!edge) expect(after).toEqual({ status, error });
      });
    }
  }

  it('terminal states have no outgoing edge; non-terminal ones do', () => {
    for (const [s, info] of Object.entries(FORWARD_STATES)) {
      const out = FORWARD_TRANSITIONS.filter((t) => t.from === s);
      expect(out.length > 0, s).toBe(!info.terminal);
    }
  });

  it('every state is reachable from a creation', () => {
    const reach = new Set<string>(Object.values(CREATIONS));
    for (let changed = true; changed;) {
      changed = false;
      for (const t of FORWARD_TRANSITIONS) if (reach.has(t.from) && !reach.has(t.to)) { reach.add(t.to); changed = true; }
    }
    expect([...reach].sort()).toEqual(Object.keys(FORWARD_STATES).sort());
    for (const f of FOLLOW_UPS) expect(FORWARD_STATES[f.from].terminal).toBe(true);
  });

  it('updateForward only reports the broadcast outcome', async () => {
    const { env, seed } = forwardDb();
    const id = seed('pending', null);
    await expect(updateForward(env, id, { status: 'confirmed' })).rejects.toBeInstanceOf(IllegalForwardTransition);
    await expect(updateForward(env, id, { status: 'blocked' })).rejects.toBeInstanceOf(IllegalForwardTransition);
    await expect(updateForward(env, id, { error: 'x' })).rejects.toBeInstanceOf(IllegalForwardTransition);
    // An owed row can never be "broadcast" — the rail does not sign in direct mode.
    const owed = seed('pending', 'direct_owed');
    expect(await updateForward(env, owed, { status: 'submitted', tx_hash: '0x1' })).toBe(false);
    expect(await updateForward(env, id, { status: 'submitted', tx_hash: '0x1' })).toBe(true);
  });
});

/// A stored row for each logical intent state.
const INTENT_SAMPLES: Array<[IntentState, string, string | null, number | null]> = [
  ['open', 'pending', null, null],
  ['underpaid', 'pending', 'ord-x', null],
  ['paid', 'paid', 'ord-x', 100],
  ['expired', 'expired', null, null],
  ['late', 'expired', 'ord-x', 100],
  ['underpaid_expired', 'expired', 'ord-x', null],
];
const INTENT_EVENTS: IntentEvent[] = ['settle_full', 'settle_short', 'settle_late', 'ttl_sweep'];

function intentDb() {
  const { db, raw } = migratedD1();
  const env = { DB: db } as unknown as Env;
  const seed = (sid: string, state: string, orderId: string | null, paidAt: number | null) =>
    raw.prepare(
      `INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, monerium_order_id, paid_at)
       VALUES (?, '0x1', 500, ?, 0, 1, ?, ?)`,
    ).run(sid, state, orderId, paidAt);
  const read = (sid: string) =>
    raw.prepare(`SELECT state, monerium_order_id, paid_at FROM payment_intents WHERE sid = ?`).get(sid) as never;
  return { env, seed, read };
}

async function fire(env: Env, sid: string, event: IntentEvent): Promise<boolean> {
  const args = { moneriumOrderId: 'ord-new', forwardId: 1, forwardTxHash: null };
  switch (event) {
    case 'settle_full': return markIntentPaid(env, sid, { ...args, amountReceivedCents: 500 });
    case 'settle_short': return markIntentUnderpaid(env, sid, { ...args, amountReceivedCents: 300 });
    case 'settle_late': return markIntentLate(env, sid, { ...args, amountReceivedCents: 500 });
    case 'ttl_sweep': return (await sweepExpiredIntents(env)).includes(sid);
  }
}

describe('intent state machine', () => {
  for (const [state, dbState, orderId, paidAt] of INTENT_SAMPLES) {
    it(`sample ${state} maps back to ${state}`, () => {
      expect(logicalIntentState({ state: dbState as never, monerium_order_id: orderId, paid_at: paidAt })).toBe(state);
    });
    for (const event of INTENT_EVENTS) {
      const edge = INTENT_TRANSITIONS.find((t) => t.from === state && t.event === event);
      it(`${state} + ${event} → ${edge ? edge.to : 'refused'}`, async () => {
        const { env, seed, read } = intentDb();
        seed('sid-1', dbState, orderId, paidAt);
        expect(await fire(env, 'sid-1', event)).toBe(Boolean(edge));
        expect(logicalIntentState(read('sid-1'))).toBe(edge ? edge.to : state);
      });
    }
  }

  it('terminal states have no outgoing edge; non-terminal ones do', () => {
    for (const [s, info] of Object.entries(INTENT_STATES)) {
      expect(INTENT_TRANSITIONS.some((t) => t.from === s), s).toBe(!info.terminal);
    }
  });
});

describe('docs/state-machines.md is generated from these tables', () => {
  const file = join(__dirname, '..', '..', 'docs', 'state-machines.md');
  const blocks: Record<string, string> = { forward: forwardMermaid(), intent: intentMermaid() };

  it('embeds the current diagrams (UPDATE_STATE_DOCS=1 rewrites them)', () => {
    let doc = readFileSync(file, 'utf8');
    for (const [name, mermaid] of Object.entries(blocks)) {
      const re = new RegExp(`(<!-- generated:${name} -->\\n)[\\s\\S]*?(\\n<!-- /generated:${name} -->)`);
      expect(re.test(doc), `markers for ${name}`).toBe(true);
      doc = doc.replace(re, `$1\`\`\`mermaid\n${mermaid}\n\`\`\`$2`);
    }
    if (process.env.UPDATE_STATE_DOCS === '1') writeFileSync(file, doc);
    expect(readFileSync(file, 'utf8')).toBe(doc);
  });
});
