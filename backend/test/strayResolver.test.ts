import { describe, expect, it } from 'vitest';

import { eurToWei, handleForward, previewStraySid, rerouteParkedOrder, type ForwardDeps } from '../src/monerium/forward';
import {
  placedAtUnix,
  resolveStray,
  STRAY_LOOKBACK_SECONDS,
  type StrayCandidate,
} from '../src/monerium/strayResolver';
import type { MoneriumOrder } from '../src/monerium/types';

const PAYEE = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';
const OTHER = '0x6693a7d19486dc45e9f90fd2d515d972bba2d65e';
const SAFE = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function cand(sid: string, created: string, expires: string, over: Partial<StrayCandidate> = {}): StrayCandidate {
  return { sid, target_address: PAYEE, state: 'expired', created_at: t(created), expires_at: t(expires), ...over };
}

// Production data, 2026-10-07 (tenant italk): three reference-less payments
// parked as no_routing_target after Revolut iOS started dropping the EPC
// remittance line.
describe('resolveStray — replay of 2026-10-07', () => {
  it('#68 1,02 € → the single intent of that amount, still open', () => {
    const res = resolveStray(
      [cand('z232pb646itg', '2026-10-07T17:55:41Z', '2026-10-07T18:10:41Z', { state: 'pending' })],
      t('2026-10-07T17:56:51Z'),
    );
    expect(res).toEqual({ kind: 'match', target: PAYEE, sids: ['z232pb646itg'], ambiguousIntent: false });
  });

  const oneEuro = [
    cand('nycwuw2m6u4t', '2026-10-07T20:26:59Z', '2026-10-07T20:41:59Z'),
    cand('sqbwkeratgmm', '2026-10-07T20:27:28Z', '2026-10-07T20:42:28Z'),
  ];

  it('#70 1,00 € → two expired intents, same payee: forward, newest first', () => {
    const res = resolveStray(oneEuro, t('2026-10-07T20:49:06Z'));
    expect(res).toEqual({
      kind: 'match',
      target: PAYEE,
      sids: ['sqbwkeratgmm', 'nycwuw2m6u4t'],
      ambiguousIntent: true,
    });
  });

  it('#71 1,00 € → the remaining one once #70 claimed sqbwkeratgmm', () => {
    // The D1 query drops intents with a live forward, so #70's claim hides it.
    const res = resolveStray([oneEuro[0]], t('2026-10-07T21:05:11Z'));
    expect(res).toMatchObject({ kind: 'match', sids: ['nycwuw2m6u4t'], ambiguousIntent: false });
  });
});

// Production, 2026-10-08 (tenant italk, order a30abad7…, forward #78): parked
// as a conflict under the single-tier rule. Rab = RAB, Lukavec = PAYEE.
describe('resolveStray — replay of 2026-10-08', () => {
  const RAB = '0x7ca5e2dcd81aa54bc2f8ee16a1d313734d314f05';
  const placed = 1791494242;
  const rows: StrayCandidate[] = [
    { sid: 'fyihzkvy9yyq', target_address: RAB, state: 'pending', created_at: 1791494201, expires_at: 1791495101 },
    { sid: 'dw52xejucz4z', target_address: RAB, state: 'pending', created_at: 1791493780, expires_at: 1791494680 },
    { sid: 'wk2bynhqjam3', target_address: PAYEE, state: 'expired', created_at: 1791479367, expires_at: 1791480267 },
  ];

  it('two open Rab checkouts + one Lukavec expired 4 h earlier → Rab, newest open first', () => {
    expect(resolveStray(rows, placed)).toEqual({
      kind: 'match',
      target: RAB,
      sids: ['fyihzkvy9yyq', 'dw52xejucz4z'],
      ambiguousIntent: true,
    });
  });
});

describe('resolveStray — decisions', () => {
  it('candidates pointing at different payees → conflict, nothing moves', () => {
    const res = resolveStray(
      [
        cand('a', '2026-10-07T20:00:00Z', '2026-10-07T20:15:00Z'),
        cand('b', '2026-10-07T20:01:00Z', '2026-10-07T20:16:00Z', { target_address: OTHER }),
      ],
      t('2026-10-07T20:05:00Z'),
    );
    expect(res.kind).toBe('conflict');
  });

  it('target comparison ignores address case', () => {
    const res = resolveStray(
      [
        cand('a', '2026-10-07T20:00:00Z', '2026-10-07T20:15:00Z'),
        cand('b', '2026-10-07T20:01:00Z', '2026-10-07T20:16:00Z', {
          target_address: PAYEE.replace('f7f', 'F7F'),
        }),
      ],
      t('2026-10-07T20:05:00Z'),
    );
    expect(res.kind).toBe('match');
  });

  it('an intent still open at placement beats a newer expired one; expired never joins the claim list', () => {
    const res = resolveStray(
      [
        cand('open', '2026-10-07T20:00:00Z', '2026-10-07T21:00:00Z', { state: 'pending' }),
        cand('newer', '2026-10-07T20:10:00Z', '2026-10-07T20:12:00Z'),
      ],
      t('2026-10-07T20:30:00Z'),
    );
    expect(res).toEqual({ kind: 'match', target: PAYEE, sids: ['open'], ambiguousIntent: false });
  });

  it('open intents agreeing on a payee win over an expired one for another payee', () => {
    const res = resolveStray(
      [
        cand('open', '2026-10-07T20:20:00Z', '2026-10-07T20:35:00Z', { state: 'pending' }),
        cand('old', '2026-10-07T16:00:00Z', '2026-10-07T16:15:00Z', { target_address: OTHER }),
      ],
      t('2026-10-07T20:21:00Z'),
    );
    expect(res).toMatchObject({ kind: 'match', target: PAYEE, sids: ['open'] });
  });

  it('open intents for different payees → conflict, even if expired ones agree', () => {
    const res = resolveStray(
      [
        cand('a', '2026-10-07T20:20:00Z', '2026-10-07T20:35:00Z', { state: 'pending' }),
        cand('b', '2026-10-07T20:21:00Z', '2026-10-07T20:36:00Z', { state: 'pending', target_address: OTHER }),
        cand('old', '2026-10-07T16:00:00Z', '2026-10-07T16:15:00Z'),
      ],
      t('2026-10-07T20:22:00Z'),
    );
    expect(res).toMatchObject({ kind: 'conflict' });
    if (res.kind === 'conflict') expect(res.candidates.map((c) => c.sid).sort()).toEqual(['a', 'b']);
  });

  it('nothing open → expired candidates decide as before, and must agree', () => {
    const res = resolveStray(
      [
        cand('a', '2026-10-07T16:00:00Z', '2026-10-07T16:15:00Z'),
        cand('b', '2026-10-07T17:00:00Z', '2026-10-07T17:15:00Z', { target_address: OTHER }),
      ],
      t('2026-10-07T20:00:00Z'),
    );
    expect(res.kind).toBe('conflict');
  });

  it('no candidates → none; a paid row is never a candidate', () => {
    expect(resolveStray([], 0)).toEqual({ kind: 'none' });
    expect(resolveStray([cand('p', '2026-10-07T20:00:00Z', '2026-10-07T20:15:00Z', { state: 'paid' })], 0))
      .toEqual({ kind: 'none' });
  });

  it('placedAtUnix falls back to now on missing / garbage input', () => {
    expect(placedAtUnix('2026-10-07T20:49:06.286862Z', 1)).toBe(t('2026-10-07T20:49:06Z'));
    expect(placedAtUnix(undefined, 42)).toBe(42);
    expect(placedAtUnix('nope', 42)).toBe(42);
  });
});

// ---- handleForward integration (same injected-deps style as forward.test.ts)

interface Rec {
  inserts: Array<Parameters<ForwardDeps['insertForward']>[0]>;
  forwards: Array<{ target: string; amountWei: bigint; sessionId?: string | null }>;
  alerts: string[];
  blocked: string[];
  windows: Array<{ amountCents: number; createdFrom: number; createdTo: number }>;
  settled: string[];
}

function harness(
  candidates: StrayCandidate[],
  over: Partial<ForwardDeps> = {},
): { deps: ForwardDeps; rec: Rec } {
  const rec: Rec = { inserts: [], forwards: [], alerts: [], blocked: [], windows: [], settled: [] };
  const intents = new Map(candidates.map((c) => [c.sid, c.target_address]));
  const deps: ForwardDeps = {
    authorize: {
      getIntentBySid: async (sid) =>
        intents.has(sid) ? { target_address: intents.get(sid)!, tenant_id: 'italk' } : null,
      getCampaignById: async () => null,
      getTenantStatus: async () => 'active',
      isWhitelisted: async (_t, addr) => addr.toLowerCase() === PAYEE,
      safeAddress: SAFE,
      defaultTenantId: 'italk',
      railTenantId: 'italk',
      requireMintAt: null,
      maxForwardCents: null,
    },
    getForwardByOrder: async () => null,
    insertForward: async (args) => {
      rec.inserts.push(args);
      return rec.inserts.length;
    },
    updateForward: async () => {},
    forward: async (args) => {
      rec.forwards.push({ target: args.target, amountWei: args.amountWei, sessionId: args.sessionId });
      return { ok: true, txHash: '0xbeef' as `0x${string}` };
    },
    settleNonRoutedPaid: async (args) => {
      rec.settled.push(args.sid);
      return true;
    },
    pollConfirmation: async () => 'confirmed',
    alert: async (text) => { rec.alerts.push(text); },
    audit: async () => {},
    emitBlocked: async (args) => { rec.blocked.push(args.reason); },
    findStrayCandidates: async (args) => {
      rec.windows.push(args);
      return candidates;
    },
    nowUnix: () => t('2026-10-08T00:00:00Z'),
    ...over,
  };
  return { deps, rec };
}

function order(memo: string, amount: string, placedAt = '2026-10-07T17:56:51.416837Z'): MoneriumOrder {
  return {
    id: 'ord-stray',
    kind: 'issue',
    state: 'processed',
    amount,
    currency: 'eur',
    memo,
    meta: { placedAt },
  } as unknown as MoneriumOrder;
}

const Z232 = cand('z232pb646itg', '2026-10-07T17:55:41Z', '2026-10-07T18:10:41Z', { state: 'pending' });

describe('handleForward — stray resolver', () => {
  it('empty memo + one matching intent → forwarded to the intent payee, tagged auto', async () => {
    const { deps, rec } = harness([Z232]);
    await handleForward(deps, order('', '1.02'));

    expect(rec.windows).toEqual([{
      amountCents: 102,
      createdFrom: t('2026-10-07T17:56:51Z') - STRAY_LOOKBACK_SECONDS,
      createdTo: t('2026-10-07T17:56:51Z') + 120,
    }]);
    expect(rec.inserts[0]).toMatchObject({ sid: 'z232pb646itg', memoPrefix: 'auto', targetAddress: PAYEE, status: 'pending' });
    expect(rec.forwards).toEqual([{ target: PAYEE, amountWei: eurToWei('1.02'), sessionId: 'z232pb646itg' }]);
    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0]).toContain('automatski');
    expect(rec.alerts[0]).not.toContain('⚠️');
  });

  it('free text without an address is still a stray', async () => {
    const { deps, rec } = harness([Z232]);
    await handleForward(deps, order('uplata za racun', '1.02'));
    expect(rec.forwards).toHaveLength(1);
  });

  it('a bare 0x memo is NOT a stray — parked, resolver never consulted', async () => {
    const { deps, rec } = harness([Z232]);
    await handleForward(deps, order(OTHER, '1.02'));
    expect(rec.windows).toHaveLength(0);
    expect(rec.forwards).toHaveLength(0);
    expect(rec.inserts[0]).toMatchObject({ status: 'blocked', error: 'not_whitelisted:unroutable_prefix' });
  });

  it('resolver off (no dep) → parks as no_routing_target, as before', async () => {
    const { deps, rec } = harness([Z232], { findStrayCandidates: undefined });
    await handleForward(deps, order('', '1.02'));
    expect(rec.forwards).toHaveLength(0);
    expect(rec.inserts[0]).toMatchObject({ status: 'failed', error: 'no_routing_target' });
  });

  it('conflicting payees → parked, alert lists candidates, merchant not told', async () => {
    const { deps, rec } = harness([
      Z232,
      cand('other1234567', '2026-10-07T17:50:00Z', '2026-10-07T18:05:00Z', { target_address: OTHER }),
    ]);
    await handleForward(deps, order('', '1.02'));
    expect(rec.forwards).toHaveLength(0);
    expect(rec.inserts[0]).toMatchObject({ status: 'failed', error: 'no_routing_target', sid: null });
    expect(rec.alerts[0]).toContain('RAZLIČITE');
    expect(rec.alerts[0]).toContain('other1234567');
    expect(rec.blocked).toHaveLength(0);
  });

  it('no matching intent → parked with an explanatory note', async () => {
    const { deps, rec } = harness([]);
    await handleForward(deps, order('', '1.02'));
    expect(rec.forwards).toHaveLength(0);
    expect(rec.alerts[0]).toContain('nema otvorenog');
  });

  it('candidate payee off the whitelist → gate still refuses, no merchant webhook', async () => {
    const { deps, rec } = harness([{ ...Z232, target_address: OTHER }]);
    await handleForward(deps, order('', '1.02'));
    expect(rec.forwards).toHaveLength(0);
    expect(rec.inserts[0]).toMatchObject({ status: 'blocked', error: 'not_whitelisted:not_whitelisted', sid: null });
    expect(rec.alerts[0]).toContain('gate odbio');
    expect(rec.blocked).toHaveLength(0);
  });

  it('first intent taken by a concurrent stray → claims the next candidate', async () => {
    const both = [
      cand('nycwuw2m6u4t', '2026-10-07T20:26:59Z', '2026-10-07T20:41:59Z'),
      cand('sqbwkeratgmm', '2026-10-07T20:27:28Z', '2026-10-07T20:42:28Z'),
    ];
    let n = 0;
    const { deps, rec } = harness(both, {
      insertForward: async (args) => {
        rec.inserts.push(args);
        return ++n === 1 ? 0 : 7; // sqbw latch lost, nycw won
      },
    });
    await handleForward(deps, order('', '1.00', '2026-10-07T20:49:06Z'));
    expect(rec.inserts.map((i) => i.sid)).toEqual(['sqbwkeratgmm', 'nycwuw2m6u4t']);
    expect(rec.forwards[0].sessionId).toBe('nycwuw2m6u4t');
    expect(rec.alerts[0]).toContain('nycwuw2m6u4t');
    expect(rec.alerts[0]).toContain('⚠️');
  });

  it('order latch lost (concurrent delivery of the same order) → stops, no park', async () => {
    const { deps, rec } = harness([Z232], {
      insertForward: async (args) => { rec.inserts.push(args); return 0; },
      getForwardByOrder: async () => ({ status: 'submitted' }),
    });
    await handleForward(deps, order('', '1.02'));
    expect(rec.inserts).toHaveLength(1);
    expect(rec.forwards).toHaveLength(0);
    expect(rec.alerts).toHaveLength(0);
  });

  it('every candidate already claimed → parked', async () => {
    const { deps, rec } = harness([Z232], {
      insertForward: async (args) => {
        rec.inserts.push(args);
        return args.status === 'pending' ? 0 : 99;
      },
    });
    await handleForward(deps, order('', '1.02'));
    expect(rec.forwards).toHaveLength(0);
    expect(rec.inserts.at(-1)).toMatchObject({ status: 'failed', error: 'no_routing_target' });
    expect(rec.alerts[0]).toContain('već preuzeti');
  });

  it('intent targeting the Safe itself → self no-op settles the resolved sid', async () => {
    const { deps, rec } = harness([{ ...Z232, target_address: SAFE }]);
    await handleForward(deps, order('', '1.02'));
    expect(rec.forwards).toHaveLength(0);
    expect(rec.inserts[0]).toMatchObject({ status: 'confirmed', memoPrefix: 'auto', sid: 'z232pb646itg' });
    expect(rec.settled).toEqual(['z232pb646itg']);
  });
});

describe('rerouteParkedOrder — operator pick', () => {
  it('forwards a parked order onto the chosen intent, tagged manual, resolver not used', async () => {
    const { deps, rec } = harness([Z232]);
    const r = await rerouteParkedOrder(deps, order('', '1.02'), 'z232pb646itg');
    expect(r).toBe('ok');
    expect(rec.windows).toHaveLength(0);
    expect(rec.inserts[0]).toMatchObject({ sid: 'z232pb646itg', memoPrefix: 'manual' });
    expect(rec.forwards[0].target).toBe(PAYEE);
    expect(rec.alerts[0]).toContain('ručno');
  });

  it('refuses an order that already has a live forward', async () => {
    const { deps, rec } = harness([Z232], { getForwardByOrder: async () => ({ status: 'confirmed' }) });
    expect(await rerouteParkedOrder(deps, order('', '1.02'), 'z232pb646itg')).toBe('already_forwarded');
    expect(rec.inserts).toHaveLength(0);
  });

  it('a parked (failed) row does not block the reroute', async () => {
    const { deps } = harness([Z232], { getForwardByOrder: async () => ({ status: 'failed' }) });
    expect(await rerouteParkedOrder(deps, order('', '1.02'), 'z232pb646itg')).toBe('ok');
  });

  it('refuses an unknown sid and an unprocessed order', async () => {
    const { deps } = harness([Z232]);
    expect(await rerouteParkedOrder(deps, order('', '1.02'), 'nepostojeci1')).toBe('unknown_sid');
    const placed = { ...order('', '1.02'), state: 'placed' } as MoneriumOrder;
    expect(await rerouteParkedOrder(deps, placed, 'z232pb646itg')).toBe('not_processed');
  });

  it('operator pick off the whitelist still parks', async () => {
    const { deps, rec } = harness([{ ...Z232, target_address: OTHER }]);
    expect(await rerouteParkedOrder(deps, order('', '1.02'), 'z232pb646itg')).toBe('ok');
    expect(rec.forwards).toHaveLength(0);
    expect(rec.inserts[0]).toMatchObject({ status: 'blocked' });
  });
});

// order.created preview (ADR 0018 dopuna 2026-10-09): same rule, read-only.
describe('previewStraySid', () => {
  const RAB = '0x7ca5e2dcd81aa54bc2f8ee16a1d313734d314f05';
  const order = (over: Partial<MoneriumOrder> = {}) => ({
    id: '0270cc5d', kind: 'issue', state: 'pending', amount: '1', currency: 'eur', memo: '',
    meta: { placedAt: '2026-10-08T22:31:31.234504193Z' }, ...over,
  }) as MoneriumOrder;
  const rows: StrayCandidate[] = [
    { sid: '9g8a69f775qd', target_address: RAB, state: 'pending', created_at: 1791498602, expires_at: 1791499502 },
    { sid: 'wk2bynhqjam3', target_address: PAYEE, state: 'expired', created_at: 1791479367, expires_at: 1791480267 },
  ];
  const calls: unknown[] = [];
  const deps = { findStrayCandidates: async (a: unknown) => { calls.push(a); return rows; } };

  it('replay 2026-10-08 22:31:31 → the open Rab checkout, window around placedAt', async () => {
    expect(await previewStraySid(deps, order())).toBe('9g8a69f775qd');
    expect(calls.at(-1)).toEqual({
      amountCents: 100,
      createdFrom: 1791498691 - STRAY_LOOKBACK_SECONDS,
      createdTo: 1791498691 + 120,
    });
  });

  it('memo with a destination, a redeem, a rejected order or resolver off → null', async () => {
    expect(await previewStraySid(deps, order({ memo: 'mpt:0x7ca5e2dcd81aa54bc2f8ee16a1d313734d314f05?sid=abc' }))).toBeNull();
    expect(await previewStraySid(deps, order({ kind: 'redeem' }))).toBeNull();
    expect(await previewStraySid(deps, order({ state: 'rejected' }))).toBeNull();
    expect(await previewStraySid({}, order())).toBeNull();
  });

  it('conflict → null (checkout keeps waiting)', async () => {
    const both = { findStrayCandidates: async () => [rows[0], { ...rows[0], sid: 'zz', target_address: PAYEE }] };
    expect(await previewStraySid(both, order())).toBeNull();
  });
});
