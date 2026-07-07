import { describe, expect, it } from 'vitest';

import { computeStage } from '../src/intents/stage';
import type { StageForward, StageInput, StageOrder } from '../src/intents/stage';

const NOW = 1_800_000_000;

function baseIntent(over: Partial<StageInput['intent']> = {}): StageInput['intent'] {
  return {
    state: 'pending',
    created_at: NOW - 30,
    expires_at: NOW + 870,
    paid_at: null,
    ...over,
  };
}

function order(over: Partial<StageOrder> = {}): StageOrder {
  return {
    id: 'ord-1',
    state: 'placed',
    memo: 'mpt:0x449abcef4e29a7dd8d98db451af2c463561baf2e?sid=abc123def456',
    reference_number: null,
    tx_hashes: null,
    placed_at: new Date((NOW - 10) * 1000).toISOString(),
    processed_at: null,
    raw_json: '{}',
    updated_at: NOW - 10,
    ...over,
  };
}

function processedOrder(over: Partial<StageOrder> = {}): StageOrder {
  return order({
    state: 'processed',
    tx_hashes: JSON.stringify(['0xmint1']),
    processed_at: new Date((NOW - 5) * 1000).toISOString(),
    updated_at: NOW - 5,
    ...over,
  });
}

function forward(over: Partial<StageForward> = {}): StageForward {
  return {
    status: 'submitted',
    tx_hash: '0xfwd1',
    error: null,
    created_at: NOW - 3,
    updated_at: NOW - 3,
    ...over,
  };
}

function step(result: ReturnType<typeof computeStage>, key: string) {
  const s = result.steps.find((x) => x.key === key);
  if (!s) throw new Error(`step ${key} missing`);
  return s;
}

describe('computeStage', () => {
  it('no order → awaiting_payment (blind window, elapsed only)', () => {
    const r = computeStage({ intent: baseIntent(), order: null, forward: null, now: NOW });
    expect(r.stage).toBe('awaiting_payment');
    expect(r.elapsed_seconds).toBe(30);
    expect(r.seconds_in_stage).toBe(30);
    expect(step(r, 'payment').status).toBe('waiting');
    expect(step(r, 'processing').status).toBe('waiting');
    // Rail default: forwarding step present while blind.
    expect(step(r, 'forwarding').status).toBe('waiting');
  });

  it('order placed → received_processing, payment step proven', () => {
    const r = computeStage({ intent: baseIntent(), order: order(), forward: null, now: NOW });
    expect(r.stage).toBe('received_processing');
    expect(step(r, 'payment').status).toBe('proven');
    expect(step(r, 'payment').at).toBe(NOW - 10);
    expect(step(r, 'processing').status).toBe('in_progress');
    expect(r.seconds_in_stage).toBe(10);
  });

  it('order pending → received_processing (review/mint/settlement conflated)', () => {
    const r = computeStage({
      intent: baseIntent(), order: order({ state: 'pending' }), forward: null, now: NOW,
    });
    expect(r.stage).toBe('received_processing');
  });

  it('processed + forward expected but not yet created → minted', () => {
    const r = computeStage({
      intent: baseIntent(), order: processedOrder(), forward: null, now: NOW,
    });
    expect(r.stage).toBe('minted');
    expect(r.forward_expected).toBe(true);
    expect(step(r, 'minted').status).toBe('proven');
    expect(step(r, 'minted').tx_hashes).toEqual(['0xmint1']);
    expect(step(r, 'forwarding').status).toBe('waiting');
  });

  it('processed without routed memo (bare 0x, direct mint) → settled, no forwarding step', () => {
    const r = computeStage({
      intent: baseIntent(),
      order: processedOrder({ memo: '0x449abcef4e29a7dd8d98db451af2c463561baf2e' }),
      forward: null,
      now: NOW,
    });
    expect(r.stage).toBe('settled');
    expect(r.forward_expected).toBe(false);
    expect(r.steps.map((s) => s.key)).not.toContain('forwarding');
    expect(step(r, 'settled').status).toBe('proven');
  });

  it('forward submitted → forwarding (broadcast, awaiting mining)', () => {
    const r = computeStage({
      intent: baseIntent(), order: processedOrder(), forward: forward(), now: NOW,
    });
    expect(r.stage).toBe('forwarding');
    expect(r.forward_tx_hash).toBe('0xfwd1');
    expect(step(r, 'forwarding').status).toBe('in_progress');
    expect(step(r, 'settled').status).toBe('waiting');
  });

  it('forward confirmed → settled with on-chain proof', () => {
    const r = computeStage({
      intent: baseIntent({ state: 'paid', paid_at: NOW - 3 }),
      order: processedOrder(),
      forward: forward({ status: 'confirmed', updated_at: NOW - 1 }),
      now: NOW,
    });
    expect(r.stage).toBe('settled');
    expect(step(r, 'forwarding').status).toBe('proven');
    expect(step(r, 'settled').status).toBe('proven');
    expect(step(r, 'settled').tx_hash).toBe('0xfwd1');
    expect(r.seconds_in_stage).toBe(1);
  });

  it('self-target noop forward (confirmed immediately) → settled', () => {
    const r = computeStage({
      intent: baseIntent(),
      order: processedOrder(),
      forward: forward({ status: 'confirmed', tx_hash: null, error: 'self_target_noop' }),
      now: NOW,
    });
    expect(r.stage).toBe('settled');
  });

  it('forward failed → stays minted, forwarding step carries failed', () => {
    const r = computeStage({
      intent: baseIntent(), order: processedOrder(),
      forward: forward({ status: 'failed', tx_hash: null, error: 'rpc_down' }),
      now: NOW,
    });
    expect(r.stage).toBe('minted');
    expect(step(r, 'forwarding').status).toBe('failed');
  });

  it('order rejected → terminal rejected with free-text reason passthrough', () => {
    const r = computeStage({
      intent: baseIntent(),
      order: order({
        state: 'rejected',
        raw_json: JSON.stringify({ meta: { rejectedReason: 'Insufficient funds' } }),
      }),
      forward: null,
      now: NOW,
    });
    expect(r.stage).toBe('rejected');
    expect(r.rejected_reason).toBe('Insufficient funds');
    expect(step(r, 'processing').status).toBe('failed');
  });

  it('intent expired, order never arrived → terminal expired', () => {
    const r = computeStage({
      intent: baseIntent({ state: 'expired', created_at: NOW - 2000, expires_at: NOW - 1100 }),
      order: null,
      forward: null,
      now: NOW,
    });
    expect(r.stage).toBe('expired');
    expect(step(r, 'payment').status).toBe('failed');
    expect(r.seconds_in_stage).toBe(1100);
  });

  it('order arriving AFTER expiry overrides expired (money still flows)', () => {
    const r = computeStage({
      intent: baseIntent({ state: 'expired', created_at: NOW - 2000, expires_at: NOW - 1100 }),
      order: order(),
      forward: null,
      now: NOW,
    });
    expect(r.stage).toBe('received_processing');
  });

  it('never renders progress it cannot prove: blind window has no proven/in_progress steps', () => {
    const r = computeStage({ intent: baseIntent(), order: null, forward: null, now: NOW });
    for (const s of r.steps) {
      expect(['waiting']).toContain(s.status);
    }
  });

  it('malformed tx_hashes / raw_json never throw', () => {
    const r = computeStage({
      intent: baseIntent(),
      order: processedOrder({ tx_hashes: 'not-json', raw_json: 'not-json' }),
      forward: null,
      now: NOW,
    });
    expect(r.mint_tx_hashes).toEqual([]);
    expect(r.rejected_reason).toBeNull();
  });
});
