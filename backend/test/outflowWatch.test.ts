import { describe, expect, it } from 'vitest';

import {
  CONFIRMATION_LAG,
  EXEC_FROM_MODULE_SUCCESS,
  EXECUTION_SUCCESS,
  formatEure,
  LAG_ALERT_BLOCKS,
  MAX_RANGE,
  MIN_RANGE,
  safeExecFromLogs,
  watchSafeOutflows,
  type SafeExec,
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
  /// Per tx: how the Safe executed. Default = through our Roles modifier.
  exec?: Record<string, SafeExec>;
  unhashed?: boolean;
}) {
  const rec = { alerts: [] as string[], audits: [] as Array<Record<string, unknown>>, cursor: opts.cursor, ranges: [] as Array<[bigint, bigint]> };
  const deps: OutflowWatchDeps = {
    latestBlock: async () => opts.head,
    outgoingTransfers: async (f, t) => { rec.ranges.push([f, t]); return opts.outflows ?? []; },
    safeExecEvents: async (h) => opts.exec?.[h] ?? { viaModules: [ROLES], viaOwners: false },
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
    const { deps, rec } = harness({
      head: 1000n, cursor: 900n, outflows: [out('0xdd')],
      exec: { '0xdd': { viaModules: [], viaOwners: true } },
    });
    await watchSafeOutflows(deps, W);
    expect(rec.alerts[0]).toContain('ℹ️');
    expect(rec.audits[0]).toMatchObject({ verdict: 'other' });
  });

  it('TD-01: role call through a relay contract (tx.to ≠ modifier) is still 🚨', async () => {
    // The harness never looks at tx.to — only at the Safe's module event.
    const { deps, rec } = harness({
      head: 1000n, cursor: 900n, outflows: [out('0xd1', THIEF)],
      exec: { '0xd1': { viaModules: [ROLES], viaOwners: false } },
    });
    await watchSafeOutflows(deps, W);
    expect(rec.alerts[0]).toContain('🚨');
    expect(rec.audits[0]).toMatchObject({ verdict: 'role_unknown' });
  });

  it('TD-01: transfer through a module that is not our Roles modifier → 🚨 module_unknown', async () => {
    const { deps, rec } = harness({
      head: 1000n, cursor: 900n, outflows: [out('0xd2', THIEF)],
      exec: { '0xd2': { viaModules: ['0x' + '77'.repeat(20)], viaOwners: false } },
    });
    await watchSafeOutflows(deps, W);
    expect(rec.alerts[0]).toContain('🚨');
    expect(rec.alerts[0]).toContain('modul');
    expect(rec.audits[0]).toMatchObject({ verdict: 'module_unknown' });
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

  it('TD-04: an RPC refusing a wide range gets halved ranges and the cursor still moves', async () => {
    const { deps, rec } = harness({ head: 100_000n, cursor: 0n });
    deps.outgoingTransfers = async (f, t) => {
      rec.ranges.push([f, t]);
      if (t - f + 1n > 500n) throw new Error('range too wide');
      return [];
    };
    await watchSafeOutflows(deps, W);
    expect(rec.ranges.map(([f, t]) => t - f + 1n)).toEqual([MAX_RANGE, 1000n, 500n]);
    expect(rec.cursor).toBe(500n);
  });

  it('TD-04: gives up (cursor unchanged) once the range is at MIN_RANGE', async () => {
    const { deps, rec } = harness({ head: 100_000n, cursor: 0n });
    deps.outgoingTransfers = async (f, t) => { rec.ranges.push([f, t]); throw new Error('rpc down'); };
    await expect(watchSafeOutflows(deps, W)).rejects.toThrow('rpc down');
    expect(rec.ranges.at(-1)).toEqual([1n, MIN_RANGE]);
    expect(rec.cursor).toBe(0n);
  });

  it('TD-02: a cursor far behind head alerts "lagging", deduplicated', async () => {
    const claimed = new Set<string>();
    const { deps, rec } = harness({ head: 10_000n, cursor: 10_000n - CONFIRMATION_LAG - LAG_ALERT_BLOCKS - 1n });
    deps.claimOnce = async (k) => { if (claimed.has(k)) return false; claimed.add(k); return true; };
    await watchSafeOutflows(deps, W);
    rec.cursor = 10_000n - CONFIRMATION_LAG - LAG_ALERT_BLOCKS - 1n;
    await watchSafeOutflows(deps, W);
    expect(rec.alerts.filter((a) => a.includes('zaostaje'))).toHaveLength(1);
  });

  it('a failing alert channel still advances (fail-open) but records the audit', async () => {
    const { deps, rec } = harness({ head: 1000n, cursor: 900n, outflows: [out('0xee', THIEF)] });
    deps.alert = async () => { throw new Error('telegram down'); };
    await watchSafeOutflows(deps, W);
    expect(rec.audits).toHaveLength(1);
    expect(rec.cursor).toBe(1000n - CONFIRMATION_LAG);
  });
});

describe('safeExecFromLogs', () => {
  const pad = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);
  it('reads the module from the Safe’s ExecutionFromModuleSuccess, ignoring other emitters', () => {
    const logs = [
      { address: '0x' + '99'.repeat(20), topics: [EXEC_FROM_MODULE_SUCCESS, pad(THIEF)] }, // not the Safe
      { address: SAFE.toUpperCase().replace('0X', '0x'), topics: [EXEC_FROM_MODULE_SUCCESS, pad(ROLES)] },
    ];
    expect(safeExecFromLogs(logs, SAFE)).toEqual({ viaModules: [ROLES], viaOwners: false });
  });
  it('owner execution', () => {
    expect(safeExecFromLogs([{ address: SAFE, topics: [EXECUTION_SUCCESS] }], SAFE))
      .toEqual({ viaModules: [], viaOwners: true });
  });
  it('selectors are the Safe v1.3+/v1.4.1 ones', () => {
    expect(EXEC_FROM_MODULE_SUCCESS).toBe('0x6895c13664aa4f67288b25d7a21d7aaa34916e355fb9b6fae0a139a9085becb8');
    expect(EXECUTION_SUCCESS).toBe('0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e');
  });
});

describe('formatEure', () => {
  it('formats 18-decimal wei with a decimal comma', () => {
    expect(formatEure(EUR(302))).toBe('3,02');
    expect(formatEure(EUR(5))).toBe('0,05');
    expect(formatEure(10n ** 18n * 1_000_000n)).toBe('1000000,00');
  });
});
