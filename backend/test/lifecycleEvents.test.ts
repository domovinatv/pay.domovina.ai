import { describe, expect, it } from 'vitest';

import { buildOrderLifecycleEvent } from '../src/intents/outbound';
import { computeStage } from '../src/intents/stage';
import { orderStateRank, normalizeIban } from '../src/monerium/orderState';
import type { MoneriumOrder } from '../src/monerium/types';

/// Shape of a real `order.created` payload (2026-09-26, sid faeysbwt2e7q):
/// no meta.evaluation yet — Monerium only reports it once processed.
function createdOrder(over: Partial<MoneriumOrder> = {}): MoneriumOrder {
  return {
    id: '4a0ec30d-b996-11f1-ba11-6a913df2d74b',
    kind: 'issue',
    state: 'pending',
    amount: '1',
    currency: 'eur',
    memo: 'mpt:0x6693a7d19486dc45e9f90fd2d515d972bba2d65e?sid.faeysbwt2e7q',
    meta: { placedAt: '2026-09-26T10:37:36.420826055Z' },
    counterpart: { identifier: { standard: 'iban', iban: 'LT55 3250 0134 9828 0265' } },
    ...over,
  };
}

const CORR = { sid: 'faeysbwt2e7q', campaignId: null, tenantId: 'italk', knownPayer: false };

describe('buildOrderLifecycleEvent', () => {
  it('pending order → payment.received at placedAt, review expected for a new payer', () => {
    const evt = buildOrderLifecycleEvent(createdOrder(), CORR)!;
    expect(evt.id).toBe('rcv_4a0ec30d-b996-11f1-ba11-6a913df2d74b');
    expect(evt.type).toBe('payment.received');
    expect(evt.tenantId).toBe('italk');
    expect(evt.payload).toMatchObject({
      type: 'payment.received',
      event_id: evt.id,
      occurred_at: '2026-09-26T10:37:36.420826055Z',
      sid: 'faeysbwt2e7q',
      amount_received_cents: 100,
      funds_location: 'monerium',
      settlement: 'pending',
      review_expected: true,
    });
  });

  it('known payer → review_expected false; unknown → null', () => {
    expect(buildOrderLifecycleEvent(createdOrder(), { ...CORR, knownPayer: true })!.payload.review_expected).toBe(false);
    expect(buildOrderLifecycleEvent(createdOrder(), { ...CORR, knownPayer: null })!.payload.review_expected).toBeNull();
  });

  it('processed order yields the SAME received id (outbox dedups a missed order.created)', () => {
    const a = buildOrderLifecycleEvent(createdOrder(), CORR)!;
    const b = buildOrderLifecycleEvent(createdOrder({ state: 'processed' }), CORR)!;
    expect(b.id).toBe(a.id);
    expect(b.type).toBe('payment.received');
  });

  it('rejected order → payment.rejected with reason, distinct id', () => {
    const evt = buildOrderLifecycleEvent(
      createdOrder({ state: 'rejected', meta: { rejectedReason: 'sanctions hit', processedAt: '2026-09-26T11:00:00Z' } }),
      CORR,
    )!;
    expect(evt.id).toBe('rej_4a0ec30d-b996-11f1-ba11-6a913df2d74b');
    expect(evt.payload).toMatchObject({
      type: 'payment.rejected',
      reason: 'sanctions hit',
      occurred_at: '2026-09-26T11:00:00Z',
      funds_location: 'returned_to_payer',
    });
  });

  it('no correlation or a redeem order → no event', () => {
    expect(buildOrderLifecycleEvent(createdOrder(), { ...CORR, sid: null })).toBeNull();
    expect(buildOrderLifecycleEvent(createdOrder({ kind: 'redeem' }), CORR)).toBeNull();
  });

  it('campaign correlation carries campaign_id', () => {
    const evt = buildOrderLifecycleEvent(createdOrder(), { ...CORR, sid: null, campaignId: 'camp123456' })!;
    expect(evt.payload).toMatchObject({ sid: null, campaign_id: 'camp123456' });
  });
});

describe('order state ranking', () => {
  it('never lets a retried order.created overwrite processed/rejected', () => {
    expect(orderStateRank('pending')).toBeLessThan(orderStateRank('processed'));
    expect(orderStateRank('placed')).toBeLessThan(orderStateRank('pending'));
    expect(orderStateRank('rejected')).toBe(orderStateRank('processed'));
    expect(orderStateRank('weird')).toBe(0);
  });

  it('normalizes Monerium-formatted IBANs', () => {
    expect(normalizeIban('lt55 3250 0134 9828 0265')).toBe('LT553250013498280265');
    expect(normalizeIban('  ')).toBeNull();
    expect(normalizeIban(null)).toBeNull();
  });
});

describe('computeStage review_expected', () => {
  const intent = { state: 'pending' as const, created_at: 1000, expires_at: 99_999, paid_at: null };
  const order = {
    id: 'o1', state: 'pending', memo: 'mpt:0x6693a7d19486dc45e9f90fd2d515d972bba2d65e?sid.abcdefgh',
    reference_number: null, tx_hashes: null, placed_at: '2026-09-26T10:37:36Z',
    processed_at: null, raw_json: '{}', updated_at: 1010,
  };

  it('true for a new payer while Monerium holds the funds', () => {
    const r = computeStage({ intent, order, forward: null, now: 1100, knownPayer: false });
    expect(r.stage).toBe('received_processing');
    expect(r.review_expected).toBe(true);
  });

  it('null outside received_processing or when unknown', () => {
    expect(computeStage({ intent, order, forward: null, now: 1100 }).review_expected).toBeNull();
    expect(
      computeStage({ intent, order: { ...order, state: 'processed' }, forward: null, now: 1100, knownPayer: false })
        .review_expected,
    ).toBeNull();
  });
});
