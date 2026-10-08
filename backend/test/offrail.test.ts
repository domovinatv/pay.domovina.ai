import { describe, expect, it } from 'vitest';

import { markResolvedOffRail, type OffRailDeps } from '../src/monerium/offrail';
import { checkReroute, maybeForward, type ForwardDeps } from '../src/monerium/forward';
import type { MoneriumOrder } from '../src/monerium/types';

const PAYEE = '0x6693a7d19486dc45e9f90fd2d515d972bba2d65e';
const OTHER = '0x52eab439f021111a5280fdcf682d1777428578fa';
const TX = '0x' + 'a2'.repeat(32);
const EUR = (cents: number) => BigInt(cents) * 10n ** 16n;

// The 2026-05-21 orphan: memo named PAYEE, the forward reverted, 2/3 owners
// later paid 1.03 by hand (safe-tx/003).
const order = (over: Partial<MoneriumOrder> = {}): MoneriumOrder => ({
  id: '39e395a9-5512-11f1-ba70-0ee6fbeaf60c',
  kind: 'issue',
  state: 'processed',
  amount: '1.02',
  currency: 'eur',
  memo: `mpt:${PAYEE}?sid.e6zmauemwu`,
  ...over,
}) as unknown as MoneriumOrder;

function harness(over: Partial<OffRailDeps> = {}) {
  const rec = { rows: [] as Array<Parameters<OffRailDeps['record']>[0]>, alerts: [] as string[], audits: 0 };
  const deps: OffRailDeps = {
    getForwardByOrder: async () => ({ status: 'failed' }),
    safeOutflows: async () => [{ to: PAYEE, valueWei: EUR(103) }],
    forwardIdsByTx: async () => [],
    record: async (row) => { rec.rows.push(row); return 75; },
    audit: async () => { rec.audits++; },
    alert: async (t) => { rec.alerts.push(t); },
    ...over,
  };
  return { deps, rec };
}

describe('markResolvedOffRail', () => {
  it('records the verified manual transfer and closes the order', async () => {
    const { deps, rec } = harness();
    const r = await markResolvedOffRail(deps, order(), TX.toUpperCase().replace('0X', '0x'), 'ms@ff.hr');
    expect(r).toEqual({ ok: true, forwardId: 75, to: PAYEE, valueWei: EUR(103).toString() });
    expect(rec.rows[0]).toMatchObject({ orderId: order().id, txHash: TX, to: PAYEE, amountCents: 102, sid: 'e6zmauemwu' });
    expect(rec.audits).toBe(1);
    expect(rec.alerts[0]).toContain('ms@ff.hr');
  });

  it('prefers the transfer to the memo beneficiary in a batch', async () => {
    const { deps } = harness({
      safeOutflows: async () => [{ to: OTHER, valueWei: EUR(500) }, { to: PAYEE, valueWei: EUR(103) }],
    });
    expect(await markResolvedOffRail(deps, order(), TX, 'a')).toMatchObject({ ok: true, to: PAYEE });
  });

  it.each([
    ['not a tx hash', { tx: '0x1234' }, 'bad_tx_hash'],
    ['tx failed or unknown', { safeOutflows: async () => null }, 'tx_not_found_or_failed'],
    ['tx moved nothing out of the Safe', { safeOutflows: async () => [] }, 'no_eure_outflow_from_safe'],
    ['order already forwarded', { getForwardByOrder: async () => ({ status: 'confirmed' }) }, 'already_forwarded'],
    ['order already resolved', { getForwardByOrder: async () => ({ status: 'resolved_offrail' }) }, 'already_resolved'],
    ['tx already explains another order', { forwardIdsByTx: async () => [12] }, 'tx_already_used'],
  ] as const)('refuses: %s', async (_name, over, error) => {
    const { tx, ...depsOver } = over as Partial<OffRailDeps> & { tx?: string };
    const { deps, rec } = harness(depsOver);
    expect(await markResolvedOffRail(deps, order(), tx ?? TX, 'a')).toEqual({ ok: false, error });
    expect(rec.rows).toHaveLength(0);
  });

  it('refuses an order that is not processed', async () => {
    const { deps } = harness();
    expect(await markResolvedOffRail(deps, order({ state: 'pending' }), TX, 'a')).toEqual({ ok: false, error: 'not_processed' });
  });
});

describe('a resolved_offrail order is final', () => {
  const fwdDeps = (status: string, calls: string[]) => ({
    getForwardByOrder: async () => ({ status }),
    authorize: { getIntentBySid: async () => ({ target_address: PAYEE, tenant_id: 'italk' }) },
    insertForward: async () => { calls.push('insert'); return 1; },
  }) as unknown as ForwardDeps;

  it('the admin reroute refuses it', async () => {
    expect(await checkReroute(fwdDeps('resolved_offrail', []), order(), 'e6zmauemwu')).toBe('resolved_offrail');
  });

  it('a redelivered webhook does not forward it', async () => {
    const calls: string[] = [];
    await maybeForward(fwdDeps('resolved_offrail', calls), order());
    expect(calls).toHaveLength(0);
  });
});
