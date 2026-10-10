import { describe, expect, it } from 'vitest';

import { isStuckWithoutForward } from '../src/monerium/reconcile';
import type { MoneriumOrder } from '../src/monerium/types';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// SR-05: a processed issue order with no forward row at all is stuck —
/// memo or not — from 15 min until 48 h after processing.
const NOW = 1_800_000_000;
const order = (over: Partial<MoneriumOrder> = {}, processedAgo = 20 * 60): MoneriumOrder => ({
  id: 'ord-s',
  kind: 'issue',
  state: 'processed',
  amount: '1.00',
  currency: 'eur',
  memo: null,
  meta: { state: 'processed', processedAt: new Date((NOW - processedAgo) * 1000).toISOString() },
  ...over,
} as unknown as MoneriumOrder);

function env() {
  const { db, raw } = migratedD1();
  return { env: { DB: db } as unknown as Env, raw };
}

describe('isStuckWithoutForward', () => {
  it('a reference-less (stray) order without any forward row is stuck', async () => {
    expect(await isStuckWithoutForward(env().env, order(), NOW)).toBe(true);
  });

  it('a park row counts as handled', async () => {
    const { env: e, raw } = env();
    raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, status, attempts, created_at, updated_at)
                 VALUES ('ord-s', '0x0', '0', 'blocked', 0, 0, 0)`).run();
    expect(await isStuckWithoutForward(e, order(), NOW)).toBe(false);
  });

  it('inside the grace period, after 48 h, or not processed → not stuck', async () => {
    const e = env().env;
    expect(await isStuckWithoutForward(e, order({}, 5 * 60), NOW)).toBe(false);
    expect(await isStuckWithoutForward(e, order({}, 49 * 3600), NOW)).toBe(false);
    expect(await isStuckWithoutForward(e, order({ state: 'pending', meta: { state: 'pending' } } as Partial<MoneriumOrder>), NOW)).toBe(false);
  });
});
