import { describe, expect, it } from 'vitest';

import {
  eurToWei,
  handleForward,
  owedFromRow,
  routeOwed,
  type ForwardDeps,
  type OwedForward,
} from '../src/monerium/forward';
import { listOwedForwards, transitionForward, type MoneriumForwardRow } from '../src/monerium/db';
import type { MoneriumOrder } from '../src/monerium/types';
import { railFromRow, type TenantRailRow } from '../src/tenants/rail';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0026: D4 owed debts settled by the ProjectRouter role. The role itself
/// (recipients restricted on-chain) is proven in safe-tx/009-simulate-fork;
/// here: the rail only ever broadcasts after a passing simulation, takes the
/// row before broadcasting, and without a router behaves exactly as before.

const PROJECT = '0x346230f2748745a1d19550969f0b239f3d2b5896';
const MAIN = '0xe2e21755d3f576f090ecda1d830f3fda865f37ff';
const SID = 'qygy3ghbbua3';
const TENANT = 'italk-sandbox';
const TX = `0x${'cd'.repeat(32)}` as `0x${string}`;

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
  updates: Array<{ id: number; patch: Parameters<ForwardDeps['updateForward']>[1] }>;
  simulated: number;
  claimed: number[];
  routerForwards: Array<{ target: string; amountWei: bigint }>;
  mainForwards: number;
  polled: string[];
  alerts: string[];
}

function harness(router: {
  simulate?: 'ok' | 'revert';
  claim?: boolean;
  forward?: Array<{ ok: boolean; error?: string }>;
} | null = {}): { deps: ForwardDeps; rec: Rec } {
  const rec: Rec = { inserts: [], updates: [], simulated: 0, claimed: [], routerForwards: [], mainForwards: 0, polled: [], alerts: [] };
  const forwards = [...(router?.forward ?? [{ ok: true }])];
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
      getCampaignBySafe: async (_t, safe) => (safe.toLowerCase() === PROJECT ? { campaign_id: 'stranke' } : null),
    },
    getForwardByOrder: async () => null,
    insertForward: async (args) => {
      rec.inserts.push(args);
      return 41 + rec.inserts.length;
    },
    updateForward: async (id, patch) => {
      rec.updates.push({ id, patch });
    },
    // The main path's signer: a direct rail must never use it.
    forward: async () => {
      rec.mainForwards++;
      return { ok: false, error: 'router_disabled: direct mode never signs' };
    },
    projectRouter: router === null ? undefined : {
      simulate: async () => {
        rec.simulated++;
        return router.simulate === 'revert'
          ? { ok: false, error: 'ConditionViolation(OrViolation)' }
          : { ok: true };
      },
      claimOwed: async (id) => {
        rec.claimed.push(id);
        return router.claim ?? true;
      },
      forward: async (args) => {
        rec.routerForwards.push({ target: args.target, amountWei: args.amountWei });
        const r = forwards.shift() ?? { ok: true };
        return r.ok ? { ok: true, txHash: TX } : { ok: false, error: r.error };
      },
    },
    sleep: async () => {},
    settleNonRoutedPaid: async () => true,
    pollConfirmation: async (f) => {
      rec.polled.push(f.tx_hash);
      return 'confirmed';
    },
    alert: async (t) => { rec.alerts.push(t); },
    audit: async () => {},
    emitBlocked: async () => {},
    findStrayCandidates: async () => [
      { sid: SID, target_address: PROJECT, state: 'pending', created_at: 999_900, expires_at: 1_003_600, trusted: true },
    ],
    nowUnix: () => 1_000_000,
  };
  return { deps, rec };
}

describe('D4 with a ProjectRouter (webhook path)', () => {
  it('simulation passes → claim, transfer to the project Safe, submitted, confirmed; no manual-transfer alarm', async () => {
    const { deps, rec } = harness();
    await handleForward(deps, order());
    expect(rec.inserts[0]).toMatchObject({ status: 'pending', error: 'direct_owed', sid: SID });
    expect(rec.simulated).toBe(1);
    expect(rec.claimed).toEqual([42]);
    expect(rec.routerForwards).toEqual([{ target: PROJECT, amountWei: eurToWei('2.27') }]);
    expect(rec.mainForwards).toBe(0);
    expect(rec.updates).toEqual([{ id: 42, patch: { status: 'submitted', tx_hash: TX, attempts: 1 } }]);
    expect(rec.polled).toEqual([TX]);
    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0]).toContain('proslijeđena kroz ProjectRouter');
    expect(rec.alerts.join()).not.toContain('treba ručni prijenos');
  });

  it('simulation reverts (project not in the role yet) → nothing claimed or sent, row stays owed, alarm says do NOT transfer by hand', async () => {
    const { deps, rec } = harness({ simulate: 'revert' });
    await handleForward(deps, order());
    expect(rec.inserts[0]).toMatchObject({ status: 'pending', error: 'direct_owed' });
    expect(rec.claimed).toEqual([]);
    expect(rec.routerForwards).toEqual([]);
    expect(rec.updates).toEqual([]);
    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0]).toContain('čeka ProjectRouter');
    expect(rec.alerts[0]).toContain('Ne prenositi ručno');
    expect(rec.alerts[0]).toContain('OrViolation');
  });

  it('without a ProjectRouter the D4 alarm is exactly the manual one (pre-ADR-0026 behaviour)', async () => {
    const { deps, rec } = harness(null);
    await handleForward(deps, order());
    expect(rec.inserts[0]).toMatchObject({ status: 'pending', error: 'direct_owed' });
    expect(rec.updates).toEqual([]);
    expect(rec.mainForwards).toBe(0);
    expect(rec.alerts[0]).toContain('treba ručni prijenos');
  });
});

describe('routeOwed', () => {
  const row: OwedForward = {
    id: 7, orderId: 'ord-7', sid: SID, target: PROJECT, amountWei: eurToWei('1.00'), amountCents: 100, memoPrefix: 'auto',
  };

  it('lost the claim (cron and webhook raced) → no broadcast', async () => {
    const { deps, rec } = harness({ claim: false });
    expect(await routeOwed(deps, row)).toEqual({ outcome: 'lost_race' });
    expect(rec.routerForwards).toEqual([]);
    expect(rec.updates).toEqual([]);
  });

  it('broadcast error after the claim → failed + alarm, never back to owed, no second attempt', async () => {
    const { deps, rec } = harness({ forward: [{ ok: false, error: 'execution reverted' }] });
    expect((await routeOwed(deps, row)).outcome).toBe('failed');
    expect(rec.routerForwards).toHaveLength(1);
    expect(rec.updates).toEqual([{ id: 7, patch: { status: 'failed', error: 'execution reverted', attempts: 1 } }]);
    expect(rec.alerts[0]).toContain('ProjectRouter prijenos nije uspio');
  });

  it('nonce collision → exactly one retry', async () => {
    const { deps, rec } = harness({ forward: [{ ok: false, error: 'nonce too low' }, { ok: true }] });
    expect((await routeOwed(deps, row)).outcome).toBe('submitted');
    expect(rec.routerForwards).toHaveLength(2);
    expect(rec.updates.at(-1)?.patch).toMatchObject({ status: 'submitted', tx_hash: TX });
  });

  it('poll: false (cron sweep) leaves confirmation to the reconcile cron', async () => {
    const { deps, rec } = harness();
    expect((await routeOwed(deps, row, { poll: false })).outcome).toBe('submitted');
    expect(rec.polled).toEqual([]);
  });

  it('no router at all → not routable, nothing touched', async () => {
    const { deps, rec } = harness(null);
    expect((await routeOwed(deps, row)).outcome).toBe('not_routable');
    expect(rec.updates).toEqual([]);
  });
});

describe('router_claim on the real schema', () => {
  function setup() {
    const { db, raw } = migratedD1();
    const ins = raw.prepare(
      `INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, memo_prefix, status, error,
         attempts, created_at, updated_at, tenant_id, tx_hash)
       VALUES (?, ?, ?, 100, ?, 'auto', ?, ?, 0, ?, ?, ?, ?)`,
    );
    ins.run('ord-a', PROJECT, eurToWei('1.00').toString(), 'sid-a', 'pending', 'direct_owed', 20, 20, TENANT, null);
    ins.run('ord-b', PROJECT, eurToWei('1.00').toString(), 'sid-b', 'pending', 'direct_owed', 10, 10, TENANT, null);
    ins.run('ord-c', PROJECT, eurToWei('1.00').toString(), 'sid-c', 'pending', 'direct_owed', 5, 5, 'other-tenant', null);
    ins.run('ord-d', PROJECT, eurToWei('1.00').toString(), 'sid-d', 'pending', null, 1, 1, TENANT, null);
    return { env: { DB: db } as unknown as Env, raw };
  }

  it('listOwedForwards: this tenant, owed only, oldest first', async () => {
    const { env } = setup();
    expect((await listOwedForwards(env, TENANT)).map((r) => r.sid)).toEqual(['sid-b', 'sid-a']);
  });

  it('owed → broadcasting once; the second claim is refused; error cleared; then the ordinary broadcast edge', async () => {
    const { env, raw } = setup();
    const id = (raw.prepare(`SELECT id FROM monerium_forwards WHERE sid = 'sid-b'`).get() as { id: number }).id;
    expect(await transitionForward(env, id, 'router_claim', { error: null })).toBe(true);
    expect(await transitionForward(env, id, 'router_claim', { error: null })).toBe(false);
    expect(raw.prepare(`SELECT status, error FROM monerium_forwards WHERE id = ?`).get(id))
      .toEqual({ status: 'pending', error: null });
    expect((await listOwedForwards(env, TENANT)).map((r) => r.sid)).toEqual(['sid-a']);
    expect(await transitionForward(env, id, 'broadcast_ok', { tx_hash: TX })).toBe(true);
    expect(raw.prepare(`SELECT status, tx_hash FROM monerium_forwards WHERE id = ?`).get(id))
      .toEqual({ status: 'submitted', tx_hash: TX });
  });

  it('a row that is not owed cannot be claimed', async () => {
    const { env, raw } = setup();
    const id = (raw.prepare(`SELECT id FROM monerium_forwards WHERE sid = 'sid-d'`).get() as { id: number }).id;
    expect(await transitionForward(env, id, 'router_claim', { error: null })).toBe(false);
  });

  it('owedFromRow carries the stored amount and prefix', () => {
    const r = owedFromRow({
      id: 3, tenant_id: TENANT, order_id: 'o', target_address: PROJECT, amount_wei: '2270000000000000000',
      amount_cents: 227, sid: 's', memo_prefix: 'auto', tx_hash: null, status: 'pending', error: 'direct_owed',
      attempts: 0, created_at: 0, updated_at: 0,
    } as MoneriumForwardRow);
    expect(r).toEqual({ id: 3, orderId: 'o', sid: 's', target: PROJECT, amountWei: 2_270_000_000_000_000_000n, amountCents: 227, memoPrefix: 'auto' });
  });
});

describe('rail config: a ProjectRouter only when fully configured, only in direct mode', () => {
  const row = (over: Partial<TenantRailRow>): TenantRailRow => ({
    tenant_id: TENANT, monerium_env: 'sandbox', chain: 'chiado', auth_kind: 'client_credentials',
    client_id: 'c', client_secret_enc: 'enc', refresh_token_enc: null, profile_id: 'p',
    receiving_safe: MAIN, roles_modifier: '0x8E926f20eAe8bDCED7Bb7c14F006aEC4975E1532', role_key: '0xprojectrouter',
    router_address: null, router_key_enc: 'enc:rk', eure_contract: '0x7a47605930002cc2cd2c3c408d1f33fc2a18ab71',
    rpc_url: null, webhook_secret_enc: null, webhook_subscription_id: null, outbound_webhook_url: null,
    outbound_webhook_secret_enc: null, max_forward_cents: null, mode: 'direct', verified_at: null,
    verify_report: null, created_at: 0, updated_at: 0, ...over,
  });
  const decrypt = async (field: string, blob: string | null) => `plain:${field}:${blob}`;

  it('tenant row in direct mode with role + key → ProjectRouter; the main signer still never signs', async () => {
    const r = await railFromRow({} as Env, row({}), decrypt);
    expect(r?.projectRouter).toMatchObject({ chain: 'chiado', privateKey: 'plain:router_key:enc:rk', roleKey: '0xprojectrouter' });
    expect(r?.signer.privateKey).toBe('');
  });

  it('tenant row missing any piece, or in forward mode → no ProjectRouter', async () => {
    expect((await railFromRow({} as Env, row({ router_key_enc: null }), decrypt))?.projectRouter).toBeUndefined();
    expect((await railFromRow({} as Env, row({ role_key: null }), decrypt))?.projectRouter).toBeUndefined();
    expect((await railFromRow({} as Env, row({ mode: 'forward' }), decrypt))?.projectRouter).toBeUndefined();
  });
});
