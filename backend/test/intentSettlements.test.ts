import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import type { MoneriumOrder } from '../src/monerium/types';
import { markIntentLate, markIntentPaid, markIntentUnderpaid, settlementProvider } from '../src/intents/db';
import { moneriumCreditEvent, recordMoneriumCredit } from '../src/monerium/inbox';
import { insertCreditEvent, recordMatch, type CreditEvent } from '../src/inflow/creditEvent';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0032 §4 + redoslijed 1: Monerium priljev u inbox (zapis, ne pogon) i
/// `intent_settlements` upisan u istoj transakciji kao `monerium_order_id`.

function setup() {
  const { db, raw } = migratedD1();
  const env = { DB: db } as unknown as Env;
  const seed = (sid: string, state = 'pending', amount = 500) =>
    raw.prepare(
      `INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at)
       VALUES (?, '0x1', ?, ?, 0, 1)`,
    ).run(sid, amount, state);
  const settlement = (sid: string) =>
    raw.prepare(`SELECT * FROM intent_settlements WHERE sid = ?`).get(sid) as
      | { provider: string; settlement_ref: string; credit_event_id: number | null }
      | undefined;
  const events = () =>
    raw.prepare(`SELECT provider_ref, finality, matched_sid, matched_by, match_note, settlement_ref FROM credit_events ORDER BY id`).all() as Array<
      Record<string, unknown>
    >;
  return { env, raw, seed, settlement, events };
}

function order(over: Partial<MoneriumOrder> = {}): MoneriumOrder {
  return {
    id: 'ord-1',
    kind: 'issue',
    amount: '5.00',
    currency: 'eur',
    state: 'pending',
    memo: 'sid:abc',
    counterpart: { identifier: { standard: 'iban', iban: 'HR1210010051863000160' }, details: { name: 'Ana' } },
    meta: { placedAt: '2026-11-18T10:00:00Z', processedAt: '2026-11-18T10:00:12Z' },
    ...over,
  };
}

const settleArgs = (orderId: string, cents: number) => ({
  moneriumOrderId: orderId,
  forwardId: 1,
  forwardTxHash: null,
  amountReceivedCents: cents,
});

describe('moneriumCreditEvent', () => {
  it('pending → notified, processed → booked, with payer and memo', () => {
    const n = moneriumCreditEvent(order(), 't1', 0)!;
    expect(n).toMatchObject({
      provider: 'monerium',
      providerRef: 'ord-1:notified',
      finality: 'notified',
      amountCents: 500,
      remittance: 'sid:abc',
      debtorName: 'Ana',
      debtorAccount: 'HR1210010051863000160',
      occurredAt: Date.parse('2026-11-18T10:00:00Z') / 1000,
    });
    const b = moneriumCreditEvent(order({ state: 'processed' }), 't1', 0)!;
    expect(b.providerRef).toBe('ord-1:booked');
    expect(b.occurredAt).toBe(Date.parse('2026-11-18T10:00:12Z') / 1000);
  });

  it('no event for rejected, redeem or non-EUR orders', () => {
    expect(moneriumCreditEvent(order({ state: 'rejected' }), 't1', 0)).toBeNull();
    expect(moneriumCreditEvent(order({ kind: 'redeem' }), 't1', 0)).toBeNull();
    expect(moneriumCreditEvent(order({ currency: 'gbp' }), 't1', 0)).toBeNull();
  });
});

describe('recordMoneriumCredit', () => {
  it('one row per (order, finality); a redelivery is a no-op', async () => {
    const { env, events } = setup();
    expect(await recordMoneriumCredit(env, order(), 't1', { sid: 'abc', previewSid: null })).not.toBeNull();
    expect(await recordMoneriumCredit(env, order(), 't1', { sid: 'abc', previewSid: null })).toBeNull();
    await recordMoneriumCredit(env, order({ state: 'processed' }), 't1', { sid: 'abc', previewSid: null });
    expect(events()).toEqual([
      { provider_ref: 'ord-1:notified', finality: 'notified', matched_sid: 'abc', matched_by: 'sid', match_note: null, settlement_ref: 'ord-1' },
      { provider_ref: 'ord-1:booked', finality: 'booked', matched_sid: 'abc', matched_by: 'sid', match_note: null, settlement_ref: 'ord-1' },
    ]);
  });

  it('a stray preview is a note, not a match', async () => {
    const { env, events } = setup();
    await recordMoneriumCredit(env, order({ memo: undefined }), 't1', { sid: null, previewSid: 'xyz' });
    expect(events()[0]).toMatchObject({ matched_sid: null, matched_by: null, match_note: 'stray_preview: xyz' });
  });
});

describe('intent_settlements', () => {
  it('paid writes the settlement and links the booked Monerium event', async () => {
    const { env, seed, settlement } = setup();
    seed('abc');
    await recordMoneriumCredit(env, order(), 't1', { sid: 'abc', previewSid: null });
    const booked = await recordMoneriumCredit(env, order({ state: 'processed' }), 't1', { sid: 'abc', previewSid: null });
    expect(await markIntentPaid(env, 'abc', settleArgs('ord-1', 500))).toBe(true);
    expect(settlement('abc')).toMatchObject({ provider: 'monerium', settlement_ref: 'ord-1', credit_event_id: booked });
    // A second claim neither flips nor duplicates.
    expect(await markIntentPaid(env, 'abc', settleArgs('ord-1', 500))).toBe(false);
    expect(settlement('abc')).toMatchObject({ settlement_ref: 'ord-1', credit_event_id: booked });
  });

  it('a claim that does not land writes nothing', async () => {
    const { env, seed, settlement } = setup();
    seed('abc', 'expired');
    expect(await markIntentPaid(env, 'abc', settleArgs('ord-1', 500))).toBe(false);
    expect(await markIntentUnderpaid(env, 'abc', settleArgs('ord-1', 100))).toBe(false);
    expect(settlement('abc')).toBeUndefined();
  });

  it('late settlement on an expired intent is recorded', async () => {
    const { env, seed, settlement } = setup();
    seed('abc', 'expired');
    expect(await markIntentLate(env, 'abc', settleArgs('ord-1', 500))).toBe(true);
    expect(settlement('abc')).toMatchObject({ provider: 'monerium', settlement_ref: 'ord-1', credit_event_id: null });
  });

  it('underpaid then paid on a later order follows monerium_order_id', async () => {
    const { env, raw, seed, settlement } = setup();
    seed('abc');
    expect(await markIntentUnderpaid(env, 'abc', settleArgs('ord-1', 300))).toBe(true);
    expect(settlement('abc')).toMatchObject({ settlement_ref: 'ord-1' });
    expect(await markIntentPaid(env, 'abc', settleArgs('ord-2', 500))).toBe(true);
    const row = raw.prepare(`SELECT monerium_order_id FROM payment_intents WHERE sid = 'abc'`).get() as { monerium_order_id: string };
    expect(settlement('abc')).toMatchObject({ settlement_ref: row.monerium_order_id });
  });

  it('a fiat settle is linked to its inbox event when the match is recorded', async () => {
    const { env, seed, settlement } = setup();
    seed('abc');
    const ev: CreditEvent = {
      provider: 'swan', providerRef: 'bosci_1:booked', tenantId: 't1', receivingAccountId: null, receivingIban: null,
      amountCents: 500, currency: 'EUR', remittance: 'sid:abc', endToEndId: null, debtorName: null, debtorAccount: null,
      scheme: 'sepa', finality: 'booked', occurredAt: 0, raw: null,
    };
    const id = (await insertCreditEvent(env, ev))!;
    // settleFiatCredit flips first, the adapter records the match after.
    expect(await markIntentPaid(env, 'abc', settleArgs('swan_bosci_1', 500))).toBe(true);
    expect(settlement('abc')).toMatchObject({ provider: 'swan', credit_event_id: null });
    await recordMatch(env, id, { sid: 'abc', by: 'sid', note: null, settlementRef: 'swan_bosci_1' });
    expect(settlement('abc')).toMatchObject({ provider: 'swan', settlement_ref: 'swan_bosci_1', credit_event_id: id });
  });

  it('settlementProvider reads the order id prefix', () => {
    expect(settlementProvider('swan_bosci_1')).toBe('swan');
    expect(settlementProvider('sim_abc_x')).toBe('sandbox');
    expect(settlementProvider('0f3c-uuid')).toBe('monerium');
  });
});

describe('migration 0036 backfill', () => {
  it('every intent with monerium_order_id gets a settlement row', () => {
    const raw = new DatabaseSync(':memory:');
    const dir = join(__dirname, '..', 'migrations');
    const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
    for (const f of files.filter((n) => n < '0036')) raw.exec(readFileSync(join(dir, f), 'utf8'));
    const ins = raw.prepare(
      `INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, monerium_order_id, paid_at)
       VALUES (?, '0x1', 500, ?, 5, 9, ?, ?)`,
    );
    ins.run('m1', 'paid', 'ord-uuid', 7);
    ins.run('s1', 'paid', 'swan_bosci_1', 8);
    ins.run('x1', 'pending', 'sim_x1_ab', null);
    ins.run('o1', 'pending', null, null);
    raw.exec(readFileSync(join(dir, files.find((n) => n.startsWith('0036'))!), 'utf8'));
    expect(raw.prepare(`SELECT sid, provider, settlement_ref, created_at FROM intent_settlements ORDER BY sid`).all()).toEqual([
      { sid: 'm1', provider: 'monerium', settlement_ref: 'ord-uuid', created_at: 7 },
      { sid: 's1', provider: 'swan', settlement_ref: 'swan_bosci_1', created_at: 8 },
      { sid: 'x1', provider: 'sandbox', settlement_ref: 'sim_x1_ab', created_at: 5 },
    ]);
  });
});
