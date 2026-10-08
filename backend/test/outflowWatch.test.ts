import { describe, expect, it } from 'vitest';

import {
  CONFIRMATION_LAG,
  formatEure,
  MAX_RANGE,
  watchSafeOutflows,
  type Outflow,
  type OutflowWatchDeps,
} from '../src/monerium/outflowWatch';

const SAFE = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';
const ROLES = '0x330347d656b1a5df972f758de1e25e99ec36762c';
const PAYEE = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';
const THIEF = '0x0fe72f49936158936820198d8b0af0ef509559f3';
const W = { tenantId: 'italk', safe: SAFE, rolesModifier: ROLES };
const EUR = (cents: number) => BigInt(cents) * 10n ** 16n;

function harness(opts: {
  head: bigint;
  cursor: bigint | null;
  outflows?: Outflow[];
  known?: string[];
  targets?: Record<string, string | null>;
  unhashed?: boolean;
}) {
  const rec = { alerts: [] as string[], audits: [] as Array<Record<string, unknown>>, cursor: opts.cursor, ranges: [] as Array<[bigint, bigint]> };
  const deps: OutflowWatchDeps = {
    latestBlock: async () => opts.head,
    outgoingTransfers: async (f, t) => { rec.ranges.push([f, t]); return opts.outflows ?? []; },
    txTarget: async (h) => opts.targets?.[h] ?? ROLES,
    isKnownForwardTx: async (h) => (opts.known ?? []).includes(h),
    hasUnhashedForward: async () => opts.unhashed ?? false,
    getCursor: async () => rec.cursor,
    setCursor: async (b) => { rec.cursor = b; },
    alert: async (t) => { rec.alerts.push(t); },
    audit: async (d) => { rec.audits.push(d); },
  };
  return { deps, rec };
}

const out = (txHash: string, to = PAYEE, cents = 102): Outflow => ({ txHash, blockNumber: 100n, to, value: EUR(cents) });

describe('watchSafeOutflows', () => {
  it('first run only anchors the cursor at head − lag (no backfill)', async () => {
    const { deps, rec } = harness({ head: 1000n, cursor: null });
    expect(await watchSafeOutflows(deps, W)).toBeNull();
    expect(rec.cursor).toBe(1000n - CONFIRMATION_LAG);
    expect(rec.ranges).toHaveLength(0);
  });

  it('our own forward is silent and the cursor advances', async () => {
    const { deps, rec } = harness({ head: 1000n, cursor: 900n, outflows: [out('0xaa')], known: ['0xaa'] });
    const r = await watchSafeOutflows(deps, W);
    expect(r).toMatchObject({ from: 901n, to: 1000n - CONFIRMATION_LAG, outflows: 1, flagged: 0 });
    expect(rec.alerts).toHaveLength(0);
    expect(rec.cursor).toBe(1000n - CONFIRMATION_LAG);
  });

  it('unknown transfer through the Roles modifier → 🚨 with revoke instructions', async () => {
    const { deps, rec } = harness({ head: 1000n, cursor: 900n, outflows: [out('0xbb', THIEF, 302)] });
    await watchSafeOutflows(deps, W);
    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0]).toContain('🚨');
    expect(rec.alerts[0]).toContain('3,02 EURe');
    expect(rec.alerts[0]).toContain(THIEF);
    expect(rec.audits[0]).toMatchObject({ verdict: 'role_unknown', tx_hash: '0xbb' });
  });

  it('role transfer matching a forward row without tx hash → ⚠️, not 🚨', async () => {
    const { deps, rec } = harness({ head: 1000n, cursor: 900n, outflows: [out('0xcc')], unhashed: true });
    await watchSafeOutflows(deps, W);
    expect(rec.alerts[0]).toContain('⚠️');
    expect(rec.audits[0]).toMatchObject({ verdict: 'role_unhashed' });
  });

  it('transfer outside the role (owners 2/3) → ℹ️', async () => {
    const { deps, rec } = harness({ head: 1000n, cursor: 900n, outflows: [out('0xdd')], targets: { '0xdd': SAFE } });
    await watchSafeOutflows(deps, W);
    expect(rec.alerts[0]).toContain('ℹ️');
    expect(rec.audits[0]).toMatchObject({ verdict: 'other' });
  });

  it('nothing new below the lag → no scan', async () => {
    const { deps, rec } = harness({ head: 1000n, cursor: 1000n - CONFIRMATION_LAG });
    expect(await watchSafeOutflows(deps, W)).toBeNull();
    expect(rec.ranges).toHaveLength(0);
  });

  it('catch-up is bounded to MAX_RANGE per tick', async () => {
    const { deps, rec } = harness({ head: 100_000n, cursor: 0n });
    await watchSafeOutflows(deps, W);
    expect(rec.ranges[0]).toEqual([1n, MAX_RANGE]);
    expect(rec.cursor).toBe(MAX_RANGE);
  });

  it('an RPC error leaves the cursor where it was (rescan next tick)', async () => {
    const { deps, rec } = harness({ head: 1000n, cursor: 900n });
    deps.outgoingTransfers = async () => { throw new Error('rpc down'); };
    await expect(watchSafeOutflows(deps, W)).rejects.toThrow('rpc down');
    expect(rec.cursor).toBe(900n);
  });

  it('a failing alert channel still advances (fail-open) but records the audit', async () => {
    const { deps, rec } = harness({ head: 1000n, cursor: 900n, outflows: [out('0xee', THIEF)] });
    deps.alert = async () => { throw new Error('telegram down'); };
    await watchSafeOutflows(deps, W);
    expect(rec.audits).toHaveLength(1);
    expect(rec.cursor).toBe(1000n - CONFIRMATION_LAG);
  });
});

describe('formatEure', () => {
  it('formats 18-decimal wei with a decimal comma', () => {
    expect(formatEure(EUR(302))).toBe('3,02');
    expect(formatEure(EUR(5))).toBe('0,05');
    expect(formatEure(10n ** 18n * 1_000_000n)).toBe('1000000,00');
  });
});
