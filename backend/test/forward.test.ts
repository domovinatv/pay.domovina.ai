import { describe, expect, it } from 'vitest';

import { eurToWei, handleForward, maybeForward, type ForwardDeps } from '../src/monerium/forward';
import type { MoneriumOrder } from '../src/monerium/types';

const PAYEE = '0x6693a7d19486dc45e9f90fd2d515d972bba2d65e';
const ATTACKER = '0x0fe72f49936158936820198d8b0af0ef509559f3';
const SAFE = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';

interface Recorded {
  inserts: Array<Parameters<ForwardDeps['insertForward']>[0]>;
  updates: Array<{ id: number; patch: Record<string, unknown> }>;
  forwards: Array<{ target: string; amountWei: bigint }>;
  alerts: string[];
  audits: Array<{ action: string; address?: string | null; tenantId: string | null }>;
  blocked: Array<{ reason: string; orderId: string }>;
  settledNonRouted: number;
  polls: number;
}

function harness(over: Partial<ForwardDeps> = {}): { deps: ForwardDeps; rec: Recorded } {
  const rec: Recorded = {
    inserts: [], updates: [], forwards: [], alerts: [], audits: [],
    blocked: [], settledNonRouted: 0, polls: 0,
  };
  const deps: ForwardDeps = {
    authorize: {
      getIntentBySid: async (sid) =>
        sid === 'abc123def456' ? { target_address: PAYEE, tenant_id: 'domovina' } : null,
      getCampaignById: async () => null,
      getTenantStatus: async () => 'active',
      isWhitelisted: async (_t, addr) => addr.toLowerCase() === PAYEE,
      safeAddress: SAFE,
      defaultTenantId: 'domovina',
    },
    getForwardByOrder: async () => null,
    insertForward: async (args) => {
      rec.inserts.push(args);
      return rec.inserts.length;
    },
    updateForward: async (id, patch) => {
      rec.updates.push({ id, patch: patch as Record<string, unknown> });
    },
    forward: async (args) => {
      rec.forwards.push({ target: args.target, amountWei: args.amountWei });
      return { ok: true, txHash: '0xdead' as `0x${string}` };
    },
    settleNonRoutedPaid: async () => {
      rec.settledNonRouted++;
      return true;
    },
    pollConfirmation: async () => {
      rec.polls++;
      return 'confirmed';
    },
    alert: async (text) => { rec.alerts.push(text); },
    audit: async (entry) => {
      rec.audits.push({ action: entry.action, address: entry.address, tenantId: entry.tenantId });
    },
    emitBlocked: async (args) => { rec.blocked.push({ reason: args.reason, orderId: args.orderId }); },
    ...over,
  };
  return { deps, rec };
}

function order(memo: string | null, over: Partial<MoneriumOrder> = {}): MoneriumOrder {
  return {
    id: 'ord-1',
    kind: 'issue',
    state: 'processed',
    amount: '12.34',
    currency: 'eur',
    memo,
    ...over,
  } as unknown as MoneriumOrder;
}

describe('handleForward — authorised', () => {
  it('forwards to the bound, whitelisted address', async () => {
    const { deps, rec } = harness();
    await handleForward(deps, order(`mpt:${PAYEE}?sid=abc123def456`));

    expect(rec.forwards).toEqual([{ target: PAYEE, amountWei: eurToWei('12.34') }]);
    expect(rec.inserts[0]).toMatchObject({ targetAddress: PAYEE, status: 'pending' });
    expect(rec.updates[0].patch).toMatchObject({ status: 'submitted', tx_hash: '0xdead' });
    expect(rec.polls).toBe(1);
    expect(rec.alerts).toHaveLength(0);
  });

  it('records a broadcast failure as failed, without settling anything', async () => {
    const { deps, rec } = harness({
      forward: async () => ({ ok: false, error: 'rpc down' }),
    });
    await handleForward(deps, order(`mpt:${PAYEE}?sid=abc123def456`));

    expect(rec.updates[0].patch).toMatchObject({ status: 'failed', error: 'rpc down' });
    expect(rec.polls).toBe(0);
  });

  it('treats a memo pointing at the Safe as a no-op and settles the intent', async () => {
    const { deps, rec } = harness({
      authorize: {
        ...harness().deps.authorize,
        getIntentBySid: async () => ({ target_address: SAFE, tenant_id: 'domovina' }),
      },
    });
    await handleForward(deps, order(`mpt:${SAFE}?sid=abc123def456`));

    expect(rec.forwards).toHaveLength(0);
    expect(rec.inserts[0]).toMatchObject({ status: 'confirmed', error: 'self_target_noop' });
    expect(rec.settledNonRouted).toBe(1);
  });
});

describe('handleForward — fail-closed: no value ever leaves the Safe', () => {
  const cases: Array<{ name: string; memo: string | null; reason: string }> = [
    {
      name: 'bare 0x address in the remittance',
      memo: ATTACKER,
      reason: 'unroutable_prefix',
    },
    {
      name: 'legacy gnosis: prefix',
      memo: `gnosis:${ATTACKER}?sid=abc123def456`,
      reason: 'unroutable_prefix',
    },
    {
      name: 'mpt: naming an address that belongs to no intent',
      memo: `mpt:${ATTACKER}?sid=nepostojeci1`,
      reason: 'unknown_sid',
    },
    {
      name: 'valid sid but a swapped address (reference tampering)',
      memo: `mpt:${ATTACKER}?sid=abc123def456`,
      reason: 'target_mismatch',
    },
    {
      name: 'cmp: for an unregistered campaign',
      memo: `cmp:${ATTACKER}?id=nepoznata`,
      reason: 'unknown_campaign',
    },
    {
      name: 'mpt: without a sid',
      memo: `mpt:${ATTACKER}`,
      reason: 'missing_sid',
    },
    {
      name: 'free-text memo with no address',
      memo: 'Uplata za clanarinu',
      reason: 'no_routing_target',
    },
  ];

  for (const tc of cases) {
    it(`parks: ${tc.name}`, async () => {
      const { deps, rec } = harness();
      await handleForward(deps, order(tc.memo));

      // The only thing that matters: no transfer was ever built.
      expect(rec.forwards).toHaveLength(0);
      expect(rec.polls).toBe(0);
      expect(rec.settledNonRouted).toBe(0);

      expect(rec.inserts).toHaveLength(1);
      const inserted = rec.inserts[0];
      expect(inserted.amountWei).toBe('0');
      if (tc.reason === 'no_routing_target') {
        // Pre-existing status kept so existing admin filters still work.
        expect(inserted.status).toBe('failed');
        expect(inserted.error).toBe('no_routing_target');
      } else {
        expect(inserted.status).toBe('blocked');
        expect(inserted.error).toBe(`not_whitelisted:${tc.reason}`);
      }
    });
  }

  it('parks a bound intent whose address was revoked from the whitelist', async () => {
    const { deps, rec } = harness({
      authorize: { ...harness().deps.authorize, isWhitelisted: async () => false },
    });
    await handleForward(deps, order(`mpt:${PAYEE}?sid=abc123def456`));

    expect(rec.forwards).toHaveLength(0);
    expect(rec.inserts[0]).toMatchObject({
      status: 'blocked',
      error: 'not_whitelisted:not_whitelisted',
    });
  });

  it('alerts, audits and notifies the merchant on every refusal', async () => {
    const { deps, rec } = harness();
    await handleForward(deps, order(`mpt:${ATTACKER}?sid=abc123def456`));

    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0]).toContain('target_mismatch');
    expect(rec.audits).toEqual([
      { action: 'forward.blocked', address: ATTACKER, tenantId: 'domovina' },
    ]);
    expect(rec.blocked).toEqual([{ reason: 'target_mismatch', orderId: 'ord-1' }]);
  });

  it('skips the merchant webhook when there is nothing to correlate on', async () => {
    const { deps, rec } = harness();
    await handleForward(deps, order('Uplata za clanarinu'));
    expect(rec.blocked).toHaveLength(0);
    expect(rec.alerts).toHaveLength(1); // operator still hears about it
  });

  it('records the refusal even when alerting and webhooks throw', async () => {
    const { deps, rec } = harness({
      alert: async () => { throw new Error('telegram down'); },
      emitBlocked: async () => { throw new Error('merchant down'); },
      audit: async () => { throw new Error('d1 down'); },
    });
    await expect(handleForward(deps, order(`mpt:${ATTACKER}?sid=abc123def456`))).resolves.toBeUndefined();
    expect(rec.inserts[0].status).toBe('blocked');
    expect(rec.forwards).toHaveLength(0);
  });
});

describe('maybeForward idempotency', () => {
  it('skips an order that already has a submitted forward', async () => {
    const { deps, rec } = harness({ getForwardByOrder: async () => ({ status: 'submitted' }) });
    await maybeForward(deps, order(`mpt:${PAYEE}?sid=abc123def456`));
    expect(rec.inserts).toHaveLength(0);
    expect(rec.forwards).toHaveLength(0);
  });

  it('skips an order that already confirmed', async () => {
    const { deps, rec } = harness({ getForwardByOrder: async () => ({ status: 'confirmed' }) });
    await maybeForward(deps, order(`mpt:${PAYEE}?sid=abc123def456`));
    expect(rec.forwards).toHaveLength(0);
  });

  it('retries after an earlier failure', async () => {
    const { deps, rec } = harness({ getForwardByOrder: async () => ({ status: 'failed' }) });
    await maybeForward(deps, order(`mpt:${PAYEE}?sid=abc123def456`));
    expect(rec.forwards).toHaveLength(1);
  });
});

describe('eurToWei', () => {
  it('converts without floating-point drift', () => {
    expect(eurToWei('1')).toBe(10n ** 18n);
    expect(eurToWei('12.34')).toBe(12_340_000_000_000_000_000n);
    expect(eurToWei('0.01')).toBe(10_000_000_000_000_000n);
    expect(eurToWei('1.19')).toBe(1_190_000_000_000_000_000n);
  });
});
