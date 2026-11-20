import { describe, expect, it } from 'vitest';

import type { MoneriumOrder } from '../src/monerium/types';
import type { StrayCandidate } from '../src/monerium/strayResolver';
import { STRAY_CLOCK_SKEW_SECONDS, STRAY_LOOKBACK_SECONDS } from '../src/monerium/strayResolver';
import { handleForward, previewStraySid, type ForwardDeps } from '../src/monerium/forward';
import {
  matchCreditEvent,
  matchMoneriumOrder,
  type MatcherDeps,
  type MoneriumShortRefHit,
} from '../src/inflow/matcher';
import type { CreditEvent } from '../src/inflow/creditEvent';
import { recordMoneriumCredit, recordMoneriumMatch } from '../src/monerium/inbox';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// S4 (ADR 0032 §5): Monerium decides through `inflow/matcher.ts`, the same
/// core as fiat; forward.ts executes the decision and writes it onto the
/// order's `booked` inbox event.

const SAFE = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';
const PAYEE = '0x6693a7d19486dc45e9f90fd2d515d972bba2d65e';
const OTHER = '0x1111111111111111111111111111111111111111';
const NOW = Date.parse('2026-11-20T12:00:00Z') / 1000;
const PLACED = NOW - 300;
const CODE = '5724'; // 572 + Damm check digit 4

function order(memo: string | undefined, over: Partial<MoneriumOrder> = {}): MoneriumOrder {
  return {
    id: 'ord-s4',
    kind: 'issue',
    state: 'processed',
    amount: '1.00',
    currency: 'eur',
    memo,
    address: SAFE,
    meta: { placedAt: new Date(PLACED * 1000).toISOString(), processedAt: new Date(NOW * 1000).toISOString() },
    ...over,
  } as MoneriumOrder;
}

function cand(sid: string, target = PAYEE, over: Partial<StrayCandidate> = {}): StrayCandidate {
  return { sid, target_address: target, state: 'pending', created_at: PLACED - 60, expires_at: PLACED + 600, trusted: true, ...over };
}

interface Rec {
  shortRefs: string[];
  windows: Array<{ amountCents: number; createdFrom: number; createdTo: number }>;
  matches: Array<{ orderId: string; sid: string | null; by: string | null; note: string | null }>;
  forwards: string[];
  inserts: Array<{ sid: string | null; memoPrefix: string | null; status: string }>;
}

function harness(opts: {
  strays?: StrayCandidate[] | null;
  codes?: Record<string, MoneriumShortRefHit>;
  over?: Partial<ForwardDeps>;
} = {}): { deps: ForwardDeps; rec: Rec } {
  const rec: Rec = { shortRefs: [], windows: [], matches: [], forwards: [], inserts: [] };
  const strays = opts.strays === undefined ? [] : opts.strays;
  const intents = new Map((strays ?? []).map((c) => [c.sid, c]));
  for (const h of Object.values(opts.codes ?? {})) intents.set(h.sid, cand(h.sid, h.target_address));
  const deps: ForwardDeps = {
    authorize: {
      getIntentBySid: async (sid) => {
        const c = intents.get(sid) ?? (sid === 'memo-sid' ? cand(sid) : undefined);
        return c
          ? { target_address: c.target_address, tenant_id: 'italk', state: c.state, amount_cents: 100, monerium_order_id: null }
          : null;
      },
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
      rec.inserts.push({ sid: args.sid, memoPrefix: args.memoPrefix, status: args.status });
      return rec.inserts.length;
    },
    updateForward: async () => {},
    forward: async (args) => {
      rec.forwards.push(args.target);
      return { ok: true, txHash: '0xbeef' as `0x${string}` };
    },
    settleNonRoutedPaid: async () => true,
    pollConfirmation: async () => 'confirmed',
    alert: async () => {},
    audit: async () => {},
    emitBlocked: async () => {},
    findByShortRef: async (code) => {
      rec.shortRefs.push(code);
      return opts.codes?.[code] ?? null;
    },
    findStrayCandidates: strays === null
      ? undefined
      : async (args) => {
          rec.windows.push(args);
          return strays;
        },
    nowUnix: () => NOW,
    recordMatch: async (orderId, m) => {
      rec.matches.push({ orderId, ...m });
    },
    ...opts.over,
  };
  return { deps, rec };
}

describe('matchMoneriumOrder', () => {
  it('a memo that names an intent or a destination is the payer\'s routing: nothing is looked up', async () => {
    for (const memo of [`mpt:${PAYEE}?sid=memo-sid`, `sid:memo-sid ${CODE}`, PAYEE, `gnosis:${PAYEE}`, `cmp:${PAYEE}?id=camp01`]) {
      const { deps, rec } = harness({ strays: [cand('s1')] });
      expect((await matchMoneriumOrder(deps, order(memo))).match).toEqual({ kind: 'memo' });
      expect(rec.shortRefs).toEqual([]);
      expect(rec.windows).toEqual([]);
    }
  });

  it('short code of a trusted intent wins; the resolver is not asked', async () => {
    const { deps, rec } = harness({ strays: [cand('s1')], codes: { [CODE]: { sid: 'coded', target_address: PAYEE, trusted: true } } });
    const { match } = await matchMoneriumOrder(deps, order(`Uplata ${CODE}`));
    expect(match).toMatchObject({ kind: 'short_ref', code: CODE, hit: { sid: 'coded' } });
    expect(rec.windows).toEqual([]);
  });

  it('an untrusted coded intent falls through to the stray resolver', async () => {
    const { deps } = harness({ strays: [cand('s1')], codes: { [CODE]: { sid: 'coded', target_address: OTHER, trusted: false } } });
    expect((await matchMoneriumOrder(deps, order(`Uplata ${CODE}`))).match).toMatchObject({ kind: 'stray', sids: ['s1'] });
  });

  it('the stray window is anchored on placedAt, not processedAt', async () => {
    const { deps, rec } = harness({ strays: [cand('s1')] });
    await matchMoneriumOrder(deps, order(undefined));
    expect(rec.windows).toEqual([
      { amountCents: 100, createdFrom: PLACED - STRAY_LOOKBACK_SECONDS, createdTo: PLACED + STRAY_CLOCK_SKEW_SECONDS },
    ]);
  });

  it('resolver off → none without running it; on → none / conflict as resolved', async () => {
    expect((await matchMoneriumOrder(harness({ strays: null }).deps, order(undefined))).match).toEqual({ kind: 'none', resolverRan: false });
    expect((await matchMoneriumOrder(harness({ strays: [] }).deps, order(undefined))).match).toEqual({ kind: 'none', resolverRan: true });
    const conflict = await matchMoneriumOrder(harness({ strays: [cand('a'), cand('b', OTHER)] }).deps, order(undefined));
    expect(conflict.match).toMatchObject({ kind: 'conflict' });
  });
});

describe('one core for Swan and Monerium', () => {
  function swanDeps(strays: StrayCandidate[], codes: Record<string, MoneriumShortRefHit> = {}): MatcherDeps {
    return {
      defaultTenantId: 'italk',
      nowUnix: () => NOW,
      getIntent: async () => null,
      findByShortRef: async (code) => codes[code] ?? null,
      findStrayCandidates: async () => strays,
    };
  }
  function credit(remittance: string | null): CreditEvent {
    return {
      provider: 'swan', providerRef: 'tx:booked', tenantId: 'italk', receivingAccountId: null, receivingIban: null,
      amountCents: 100, currency: 'EUR', remittance, endToEndId: null, debtorName: null, debtorAccount: null,
      scheme: null, finality: 'booked', occurredAt: PLACED, raw: null,
    };
  }

  it('the same remittance, amount and time pick the same intent', async () => {
    const strays = [cand('older', PAYEE, { created_at: PLACED - 600 }), cand('newer')];
    const codes = { [CODE]: { sid: 'coded', target_address: PAYEE, trusted: true } };
    for (const [memo, sid] of [[undefined, 'newer'], [`Uplata ${CODE}`, 'coded']] as const) {
      const swan = await matchCreditEvent(swanDeps(strays, codes), credit(memo ?? null));
      const mon = (await matchMoneriumOrder(harness({ strays, codes }).deps, order(memo))).match;
      expect(swan).toMatchObject({ kind: 'match', sid });
      expect(mon.kind === 'stray' ? mon.sids[0] : mon.kind === 'short_ref' ? mon.hit.sid : null).toBe(sid);
    }
  });
});

describe('forward executes the decision and records it on the booked event', () => {
  it('memo sid → matched_by sid', async () => {
    const { deps, rec } = harness();
    await handleForward(deps, order(`mpt:${PAYEE}?sid=memo-sid`));
    expect(rec.forwards).toEqual([PAYEE]);
    expect(rec.matches).toEqual([{ orderId: 'ord-s4', sid: 'memo-sid', by: 'sid', note: null }]);
  });

  it('short code → matched_by short_ref', async () => {
    const { deps, rec } = harness({ codes: { [CODE]: { sid: 'coded', target_address: PAYEE, trusted: true } } });
    await handleForward(deps, order(`Uplata ${CODE}`));
    expect(rec.inserts).toEqual([{ sid: 'coded', memoPrefix: 'code', status: 'pending' }]);
    expect(rec.matches).toEqual([{ orderId: 'ord-s4', sid: 'coded', by: 'short_ref', note: null }]);
  });

  it('ambiguous stray → the claimed sid, matched_by stray, candidates in the note', async () => {
    const { deps, rec } = harness({ strays: [cand('older', PAYEE, { created_at: PLACED - 600 }), cand('newer')] });
    await handleForward(deps, order(undefined));
    expect(rec.matches).toEqual([{ orderId: 'ord-s4', sid: 'newer', by: 'stray', note: 'stray_ambiguous: newer,older' }]);
  });

  it('stray whose first candidate was taken → records the one actually claimed', async () => {
    const { deps, rec } = harness({ strays: [cand('older', PAYEE, { created_at: PLACED - 600 }), cand('newer')] });
    let n = 0;
    deps.insertForward = async (args) => {
      n++;
      if (args.sid === 'newer') return 0; // per-intent latch held by another order
      rec.inserts.push({ sid: args.sid, memoPrefix: args.memoPrefix, status: args.status });
      return n;
    };
    await handleForward(deps, order(undefined));
    expect(rec.matches).toEqual([{ orderId: 'ord-s4', sid: 'older', by: 'stray', note: 'stray_ambiguous: newer,older' }]);
  });

  it('operator reroute → matched_by manual', async () => {
    const { deps, rec } = harness({ strays: [cand('picked')] });
    await handleForward(deps, order(undefined), { sid: 'picked' });
    expect(rec.windows).toEqual([]);
    expect(rec.matches).toEqual([{ orderId: 'ord-s4', sid: 'picked', by: 'manual', note: null }]);
  });

  it('park → no intent, the reason in the note', async () => {
    const { deps, rec } = harness({ strays: [] });
    await handleForward(deps, order(undefined));
    expect(rec.forwards).toEqual([]);
    expect(rec.matches).toEqual([{ orderId: 'ord-s4', sid: null, by: null, note: 'park: no_routing_target' }]);
  });

  it('a failing inbox write never stops the forward', async () => {
    const { deps, rec } = harness({ over: { recordMatch: async () => { throw new Error('d1 down'); } } });
    await handleForward(deps, order(`mpt:${PAYEE}?sid=memo-sid`));
    expect(rec.forwards).toEqual([PAYEE]);
  });

  it('preview at order.created uses the same decision', async () => {
    const strays = [cand('older', PAYEE, { created_at: PLACED - 600 }), cand('newer')];
    expect(await previewStraySid(harness({ strays }).deps, order(undefined, { state: 'pending' }))).toBe('newer');
    expect(await previewStraySid(harness({ strays }).deps, order(`mpt:${PAYEE}?sid=memo-sid`, { state: 'pending' }))).toBeNull();
  });
});

describe('recordMoneriumMatch (real D1)', () => {
  it('updates only the booked event of that order', async () => {
    const { db, raw } = migratedD1();
    const env = { DB: db } as unknown as Env;
    await recordMoneriumCredit(env, order(undefined, { state: 'pending' }), 'italk', { sid: null, previewSid: 'newer' });
    await recordMoneriumCredit(env, order(undefined), 'italk', { sid: null, previewSid: 'newer' });
    await recordMoneriumMatch(env, 'ord-s4', { sid: 'newer', by: 'stray', note: null });
    await recordMoneriumMatch(env, 'unknown-order', { sid: 'x', by: 'sid', note: null });
    expect(raw.prepare(`SELECT provider_ref, matched_sid, matched_by, match_note FROM credit_events ORDER BY id`).all()).toEqual([
      { provider_ref: 'ord-s4:notified', matched_sid: null, matched_by: null, match_note: 'stray_preview: newer' },
      { provider_ref: 'ord-s4:booked', matched_sid: 'newer', matched_by: 'stray', match_note: null },
    ]);
  });
});
