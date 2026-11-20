import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { findStrayCandidates, markIntentLate, markIntentPaid, markIntentUnderpaid } from '../src/intents/db';
import { tenantIntentStats } from '../src/intents/list';
import { migratedD1 } from './helpers/sqliteD1';

/// S1 (zatvaranje Swan): „intent je namiren” = postoji red u `intent_settlements`,
/// ne `monerium_order_id IS NOT NULL`. Dok se oboje piše u istom D1 batchu,
/// moraju se slagati za svaki put namire, a drugi pokušaj namire ne smije proći.
/// Ako bi INSERT u batchu išao prije claima, prvi claim nikad ne bi prošao;
/// ako guard ne bi gledao `intent_settlements`, drugi bi prošao.

function setup() {
  const { db, raw } = migratedD1();
  const env = { DB: db } as unknown as Env;
  const seed = (sid: string, state = 'pending', amount = 500) =>
    raw.prepare(
      `INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, tenant_id)
       VALUES (?, '0x1', ?, ?, 100, 200, 't1')`,
    ).run(sid, amount, state);
  const consistent = () =>
    raw.prepare(
      `SELECT sid FROM payment_intents i
        WHERE (i.monerium_order_id IS NOT NULL) <> EXISTS (SELECT 1 FROM intent_settlements s WHERE s.sid = i.sid)`,
    ).all();
  const settlement = (sid: string) =>
    raw.prepare(`SELECT provider, settlement_ref FROM intent_settlements WHERE sid = ?`).get(sid);
  return { env, raw, seed, consistent, settlement };
}

const args = (orderId: string, cents: number) => ({
  moneriumOrderId: orderId,
  forwardId: 1,
  forwardTxHash: null,
  amountReceivedCents: cents,
});

type Mark = typeof markIntentPaid;
const cases: Array<{ name: string; state: string; mark: Mark; order: string; cents: number; provider: string }> = [
  { name: 'paid (Monerium)', state: 'pending', mark: markIntentPaid, order: 'ord-uuid', cents: 500, provider: 'monerium' },
  { name: 'underpaid', state: 'pending', mark: markIntentUnderpaid, order: 'ord-uuid', cents: 300, provider: 'monerium' },
  { name: 'late', state: 'expired', mark: markIntentLate, order: 'ord-uuid', cents: 500, provider: 'monerium' },
  { name: 'sandbox', state: 'pending', mark: markIntentPaid, order: 'sim_abc_x1', cents: 500, provider: 'sandbox' },
  { name: 'swan', state: 'pending', mark: markIntentPaid, order: 'swan_bosci_1', cents: 500, provider: 'swan' },
];

describe('monerium_order_id ⇔ intent_settlements', () => {
  for (const c of cases) {
    it(`${c.name}: first claim lands, settlement row matches, a redelivery does not`, async () => {
      const { env, seed, consistent, settlement } = setup();
      seed('abc', c.state);
      expect(consistent()).toEqual([]);
      expect(await c.mark(env, 'abc', args(c.order, c.cents))).toBe(true);
      expect(settlement('abc')).toEqual({ provider: c.provider, settlement_ref: c.order });
      expect(consistent()).toEqual([]);
      // Dvostruki webhook: isti order, pa drugi order istog iznosa.
      expect(await c.mark(env, 'abc', args(c.order, c.cents))).toBe(false);
      expect(await c.mark(env, 'abc', args(`${c.order}-2`, c.cents))).toBe(false);
      expect(settlement('abc')).toEqual({ provider: c.provider, settlement_ref: c.order });
      expect(consistent()).toEqual([]);
    });
  }

  it('late cannot claim an intent that already has a settlement row', async () => {
    const { env, raw, seed } = setup();
    seed('abc', 'expired');
    raw.prepare(
      `INSERT INTO intent_settlements (sid, provider, settlement_ref, credit_event_id, created_at) VALUES ('abc', 'swan', 'swan_x', NULL, 1)`,
    ).run();
    expect(await markIntentLate(env, 'abc', args('ord-uuid', 500))).toBe(false);
    expect(await markIntentUnderpaid(env, 'abc', args('ord-uuid', 100))).toBe(false);
  });
});

describe('readers follow intent_settlements', () => {
  it('stray candidates skip settled intents (also settlement-only); stats buckets late/underpaid', async () => {
    const { env, raw, seed } = setup();
    for (const sid of ['open', 'under', 'late', 'expd']) seed(sid, sid === 'late' || sid === 'expd' ? 'expired' : 'pending');
    seed('paid');
    await markIntentUnderpaid(env, 'under', args('ord-u', 300));
    await markIntentLate(env, 'late', args('ord-l', 500));
    await markIntentPaid(env, 'paid', args('swan_p', 500));
    // S3 oblik: fiat namira bez sintetskog ordera — samo red u intent_settlements.
    seed('fiat');
    raw.prepare(
      `INSERT INTO intent_settlements (sid, provider, settlement_ref, credit_event_id, created_at) VALUES ('fiat', 'swan', 'bosci_9', NULL, 1)`,
    ).run();

    const cand = await findStrayCandidates(env, {
      tenantId: 't1', defaultTenantId: 'default', amountCents: 500, createdFrom: 0, createdTo: 1000,
    });
    expect(cand.map((c) => c.sid).sort()).toEqual(['expd', 'open']);

    const stats = await tenantIntentStats(env, { tenantId: 't1', createdFrom: null, createdTo: null } as never);
    const n = (k: string) => (stats as unknown as Record<string, { count: number }>)[k]?.count ?? 0;
    expect([n('paid'), n('underpaid'), n('late'), n('expired'), n('pending')]).toEqual([1, 2, 1, 1, 1]);
  });
});
