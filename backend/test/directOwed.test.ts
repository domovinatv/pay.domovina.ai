import { describe, expect, it } from 'vitest';

import { handleForward, type ForwardDeps } from '../src/monerium/forward';
import type { MoneriumOrder } from '../src/monerium/types';
import { classify, settleOwedOutflow, watchSafeOutflows, type OutflowWatchDeps } from '../src/monerium/outflowWatch';
import { eurToWei } from '../src/monerium/forward';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// Direct mode, the two cases that used to park (docs/2026-10-11-funding-po-projektu.md):
///   D4 — the reference was lost (Revolut), Monerium minted into the main Safe:
///        the order is bound to its intent as an OWED transfer; the outflow
///        watcher settles it when the 2/3 owners move exactly that amount.
///   D6 — `<chain>:0x<project Safe>` without a sid minted straight into the
///        project: a contribution, no park, no alarm.

const PROJECT = '0x346230f2748745a1d19550969f0b239f3d2b5896';
const MAIN = '0xe2e21755d3f576f090ecda1d830f3fda865f37ff';
const OTHER = '0x0fe72f49936158936820198d8b0af0ef509559f3';
const SID = 'qygy3ghbbua3';
const TENANT = 'italk-sandbox';

function order(over: Partial<MoneriumOrder> = {}): MoneriumOrder {
  return {
    id: 'ord-owed-1', kind: 'issue', profile: 'prof-sb', address: MAIN, chain: 'chiado',
    currency: 'eur', amount: '2.27', memo: 'Donacija', state: 'processed',
    meta: { placedAt: new Date(1_000_000 * 1000).toISOString() },
    counterpart: { identifier: { standard: 'iban', iban: 'BG80BNBG96611020345678' }, details: { name: 'Test Darovatelj' } },
    ...over,
  } as MoneriumOrder;
}

interface Rec {
  inserts: Array<Parameters<ForwardDeps['insertForward']>[0]>;
  forwards: number;
  alerts: string[];
  settled: string[];
  contributions: Array<{ campaignId: string; targetAddress: string; amountCents: number | null }>;
}

function harness(opts: { stray?: boolean; campaign?: boolean } = {}): { deps: ForwardDeps; rec: Rec } {
  const rec: Rec = { inserts: [], forwards: 0, alerts: [], settled: [], contributions: [] };
  const deps: ForwardDeps = {
    authorize: {
      getIntentBySid: async (sid) => (sid === SID ? { target_address: PROJECT, tenant_id: TENANT } : null),
      getCampaignById: async () => null,
      getTenantStatus: async () => 'active',
      isWhitelisted: async () => true,
      safeAddress: MAIN,
      defaultTenantId: 'italk',
      railTenantId: TENANT,
      requireMintAt: MAIN,
      maxForwardCents: null,
      mode: 'direct',
      getCampaignBySafe: async (_t, safe) =>
        opts.campaign !== false && safe.toLowerCase() === PROJECT ? { campaign_id: 'domovinatv-stranke-domovina-ai' } : null,
    },
    getForwardByOrder: async () => null,
    insertForward: async (args) => {
      rec.inserts.push(args);
      return rec.inserts.length;
    },
    updateForward: async () => {},
    forward: async () => {
      rec.forwards++;
      return { ok: true, txHash: '0xdead' as `0x${string}` };
    },
    settleNonRoutedPaid: async (a) => {
      rec.settled.push(a.sid);
      return true;
    },
    pollConfirmation: async () => 'confirmed',
    alert: async (t) => { rec.alerts.push(t); },
    audit: async () => {},
    emitBlocked: async () => {},
    emitContribution: async (a) => { rec.contributions.push(a); },
    findStrayCandidates: opts.stray === false
      ? undefined
      : async () => [{ sid: SID, target_address: PROJECT, state: 'pending', created_at: 999_900, expires_at: 1_003_600, trusted: true }],
    nowUnix: () => 1_000_000,
  };
  return { deps, rec };
}

describe('D4: reference lost, minted into the main Safe', () => {
  it('stray match → owed transfer bound to the intent, alert with the instruction, nothing signed', async () => {
    const { deps, rec } = harness();
    await handleForward(deps, order());
    expect(rec.forwards).toBe(0);
    expect(rec.settled).toEqual([]); // paid only once the money is in the project Safe
    expect(rec.inserts).toHaveLength(1);
    expect(rec.inserts[0]).toMatchObject({
      orderId: 'ord-owed-1', targetAddress: PROJECT, amountWei: eurToWei('2.27').toString(),
      amountCents: 227, status: 'pending', error: 'direct_owed', sid: SID, memoPrefix: 'auto',
    });
    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0]).toContain('treba ručni prijenos');
    expect(rec.alerts[0]).toContain(`točno 2.27 EURe</b> → <code>${PROJECT}`);
    expect(rec.alerts[0]).not.toContain('blokiran');
  });

  it('a sid in the memo but minted into the main Safe (no space after the address) → owed too', async () => {
    const { deps, rec } = harness({ stray: false });
    await handleForward(deps, order({ memo: `chiado:${PROJECT}?sid=${SID}` }));
    expect(rec.inserts[0]).toMatchObject({ status: 'pending', error: 'direct_owed', sid: SID });
  });

  it('resolver not sure (no candidate) → still parked with the alarm', async () => {
    const { deps, rec } = harness({ stray: false });
    await handleForward(deps, order());
    expect(rec.inserts[0]).toMatchObject({ status: 'failed', error: 'no_routing_target' });
    expect(rec.alerts[0]).toContain('blokiran');
  });

  it('minted at an address that is neither the target nor the main Safe → parked', async () => {
    const { deps, rec } = harness({ stray: false });
    await handleForward(deps, order({ address: OTHER, memo: `sid:${SID}` }));
    expect(rec.inserts[0]?.error).toBe('not_whitelisted:not_minted_to_target');
  });
});

describe('D6: project Safe without a sid', () => {
  it('minted straight into a campaign Safe → contribution, no park, no alarm', async () => {
    const { deps, rec } = harness({ stray: false });
    await handleForward(deps, order({ address: PROJECT, memo: `chiado:${PROJECT}`, amount: '4.44' }));
    expect(rec.alerts).toEqual([]);
    expect(rec.forwards).toBe(0);
    expect(rec.inserts[0]).toMatchObject({
      targetAddress: PROJECT, amountWei: '0', status: 'confirmed', error: 'direct_contribution', sid: null, memoPrefix: 'chiado',
    });
    expect(rec.contributions).toEqual([expect.objectContaining({
      campaignId: 'domovinatv-stranke-domovina-ai', targetAddress: PROJECT, amountCents: 444,
      senderIban: 'BG80BNBG96611020345678',
    })]);
  });

  it('a Safe that is not a campaign → still missing_sid', async () => {
    const { deps, rec } = harness({ stray: false, campaign: false });
    await handleForward(deps, order({ address: PROJECT, memo: `chiado:${PROJECT}` }));
    expect(rec.inserts[0]?.error).toBe('not_whitelisted:missing_sid');
  });
});

describe('D4 settlement: the outflow watcher recognises the owners’ transfer', () => {
  async function setup(owed: Array<{ sid: string; amount: string; created: number }>) {
    const { db, raw } = migratedD1();
    for (const [i, o] of owed.entries()) {
      raw.prepare(
        `INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id)
         VALUES (?, ?, ?, 'EUR', 'pending', 0, 999999999, ?)`,
      ).run(o.sid, PROJECT, Math.round(Number(o.amount) * 100), TENANT);
      raw.prepare(
        `INSERT INTO monerium_orders (id, kind, state, amount, currency, address, memo, raw_json, updated_at, tenant_id)
         VALUES (?, 'issue', 'processed', ?, 'eur', ?, 'Donacija', '{}', 0, ?)`,
      ).run(`ord-${i}`, o.amount, MAIN, TENANT);
      raw.prepare(
        `INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, memo_prefix, status, error,
           attempts, created_at, updated_at, tenant_id)
         VALUES (?, ?, ?, ?, ?, 'auto', 'pending', 'direct_owed', 0, ?, ?, ?)`,
      ).run(`ord-${i}`, PROJECT, eurToWei(o.amount).toString(), Math.round(Number(o.amount) * 100), o.sid, o.created, o.created, TENANT);
    }
    const env = { DB: db, DEFAULT_TENANT_ID: 'italk' } as unknown as Env;
    return { env, raw };
  }
  const leg = (amount: string, logIndex: number, txHash = '0x' + 'ab'.repeat(32)) =>
    ({ txHash, blockNumber: 1n, to: PROJECT, value: eurToWei(amount), logIndex });

  it('exact amount → row confirmed with the tx, intent paid', async () => {
    const { env, raw } = await setup([{ sid: SID, amount: '2.27', created: 10 }]);
    expect(await settleOwedOutflow(env, TENANT, leg('2.27', 3))).toMatchObject({ sid: SID });
    expect(raw.prepare(`SELECT status, tx_hash, tx_log_index FROM monerium_forwards`).get())
      .toMatchObject({ status: 'confirmed', tx_hash: '0x' + 'ab'.repeat(32), tx_log_index: 3 });
    expect(raw.prepare(`SELECT state, monerium_order_id FROM payment_intents WHERE sid = ?`).get(SID))
      .toMatchObject({ state: 'paid', monerium_order_id: 'ord-0' });
  });

  it('a different amount matches nothing', async () => {
    const { env } = await setup([{ sid: SID, amount: '2.27', created: 10 }]);
    expect(await settleOwedOutflow(env, TENANT, leg('2.28', 0))).toBeNull();
  });

  it('one batch pays two owed rows leg by leg, oldest first; a rescan pays nothing twice', async () => {
    const { env, raw } = await setup([
      { sid: 'second-intent', amount: '5.00', created: 20 },
      { sid: 'first-intent1', amount: '5.00', created: 10 },
    ]);
    expect(await settleOwedOutflow(env, TENANT, leg('5.00', 1))).toMatchObject({ sid: 'first-intent1' });
    expect(await settleOwedOutflow(env, TENANT, leg('5.00', 2))).toMatchObject({ sid: 'second-intent' });
    expect(await settleOwedOutflow(env, TENANT, leg('5.00', 1))).toBeNull();
    const states = raw.prepare(`SELECT state FROM payment_intents ORDER BY sid`).all();
    expect(states).toEqual([{ state: 'paid' }, { state: 'paid' }]);
  });

  const w = { tenantId: TENANT, safe: MAIN, rolesModifier: '' };
  const base = (over: Partial<OutflowWatchDeps>): OutflowWatchDeps => ({
    latestBlock: async () => 100n,
    outgoingTransfers: async () => [],
    safeExecEvents: async () => ({ viaModules: [], viaOwners: true }),
    isKnownForwardTx: async () => false,
    hasUnhashedForward: async () => false,
    getCursor: async () => 50n,
    setCursor: async () => {},
    alert: async () => {},
    audit: async () => {},
    ...over,
  });

  it('owner-signed transfer that settles an owed row → ✅, not flagged', async () => {
    const alerts: string[] = [];
    const deps = base({
      outgoingTransfers: async () => [leg('2.27', 0)],
      settleOwed: async () => ({ forwardId: 1, sid: SID }),
      alert: async (t) => { alerts.push(t); },
    });
    const r = await watchSafeOutflows(deps, w);
    expect(r?.flagged).toBe(0);
    expect(alerts[0]).toContain('Ručni prijenos prepoznat');
  });

  it('a module transfer never settles an owed row (🚨 stays)', async () => {
    let asked = false;
    const deps = base({
      safeExecEvents: async () => ({ viaModules: ['0x' + '77'.repeat(20)], viaOwners: false }),
      settleOwed: async () => { asked = true; return { forwardId: 1, sid: SID }; },
    });
    expect(await classify(deps, w, leg('2.27', 0))).toBe('module_unknown');
    expect(asked).toBe(false);
  });

  it('an owner transfer with no owed row is still reported as unexplained', async () => {
    const deps = base({ settleOwed: async () => null });
    expect(await classify(deps, w, leg('9.99', 0))).toBe('other');
  });
});
