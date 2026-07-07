import { describe, expect, it } from 'vitest';

import {
  CONFIRM_POLL_DELAYS_MS,
  pollForwardConfirmation,
  reconcileSubmittedForwards,
  settleConfirmedForward,
  settleNonRoutedPaid,
} from '../src/intents/confirm';
import type { ConfirmDeps } from '../src/intents/confirm';
import type { PaymentIntentRow } from '../src/intents/db';
import type { MoneriumForwardRow, MoneriumOrderRow } from '../src/monerium/db';
import type { SenderInfo } from '../src/monerium/sid';

const NOW = 1_800_000_000;

function intentRow(over: Partial<PaymentIntentRow> = {}): PaymentIntentRow {
  return {
    sid: 'sid123abc',
    target_address: '0x1111111111111111111111111111111111111111',
    amount_cents: 500,
    currency: 'eur',
    label: null,
    metadata_json: null,
    state: 'pending',
    created_at: NOW - 30,
    expires_at: NOW + 870,
    paid_at: null,
    monerium_order_id: null,
    forward_id: null,
    forward_tx_hash: null,
    amount_received_cents: null,
    ...over,
  };
}

function forwardRow(over: Partial<MoneriumForwardRow> = {}): MoneriumForwardRow {
  return {
    id: 1,
    order_id: 'ord-1',
    target_address: '0x1111111111111111111111111111111111111111',
    amount_wei: '5000000000000000000',
    amount_cents: 500,
    sid: 'sid123abc',
    memo_prefix: 'mpt',
    tx_hash: '0xfwd1',
    status: 'submitted',
    error: null,
    attempts: 1,
    created_at: NOW - 100,
    updated_at: NOW - 100,
    ...over,
  };
}

function orderRow(over: Partial<MoneriumOrderRow> = {}): MoneriumOrderRow {
  return {
    id: 'ord-1',
    profile_id: null,
    account_id: null,
    kind: 'issue',
    state: 'processed',
    amount: '5.00',
    currency: 'eur',
    address: null,
    chain: 'gnosis',
    counterpart_iban: 'HR1210010051863000160',
    counterpart_name: 'Pero Perić',
    memo: 'mpt:0x1111111111111111111111111111111111111111?sid=sid123abc',
    reference_number: null,
    tx_hashes: JSON.stringify(['0xmint1']),
    placed_at: null,
    processed_at: null,
    raw_json: '{}',
    updated_at: NOW - 10,
    ...over,
  };
}

/// In-memory ConfirmDeps double. Mirrors the real single-fire semantics:
/// confirmForwardOnce only wins from `submitted`, markIntentPaid only flips
/// `pending`. `statuses[i]` is the i-th getForwardStatus answer (last one
/// repeats).
function makeDeps(opts: {
  statuses?: Array<'pending' | 'confirmed' | 'failed' | 'unknown'>;
  forwards?: MoneriumForwardRow[];
  intents?: PaymentIntentRow[];
  orders?: MoneriumOrderRow[];
}) {
  const forwards = new Map((opts.forwards ?? []).map((f) => [f.id, f]));
  const intents = new Map((opts.intents ?? []).map((i) => [i.sid, i]));
  const orders = new Map((opts.orders ?? []).map((o) => [o.id, o]));
  const paidWebhooks: Array<{ sid: string; sender: SenderInfo }> = [];
  const campaignWebhooks: Array<Record<string, unknown>> = [];
  const sleeps: number[] = [];
  let statusCalls = 0;
  const deps: ConfirmDeps = {
    async getForwardStatus() {
      const s = opts.statuses ?? ['unknown'];
      const v = s[Math.min(statusCalls, s.length - 1)];
      statusCalls++;
      return v;
    },
    async confirmForwardOnce(id) {
      const f = forwards.get(id);
      if (!f || f.status !== 'submitted') return false;
      f.status = 'confirmed';
      return true;
    },
    async markForwardFailed(id, error) {
      const f = forwards.get(id);
      if (f) {
        f.status = 'failed';
        f.error = error;
      }
    },
    async getOrder(id) {
      return orders.get(id) ?? null;
    },
    async getIntent(sid) {
      return intents.get(sid) ?? null;
    },
    async markIntentPaid(sid, args) {
      const i = intents.get(sid);
      if (!i || i.state !== 'pending') return false;
      i.state = 'paid';
      i.paid_at = NOW;
      i.monerium_order_id = args.moneriumOrderId;
      i.forward_id = args.forwardId;
      i.forward_tx_hash = args.forwardTxHash;
      i.amount_received_cents = args.amountReceivedCents;
      return true;
    },
    async emitIntentPaid(intent, sender) {
      paidWebhooks.push({ sid: intent.sid, sender });
    },
    async emitCampaignContribution(args) {
      campaignWebhooks.push(args);
    },
    async listSubmittedForwards(olderThan) {
      return [...forwards.values()].filter(
        (f) => f.status === 'submitted' && f.tx_hash !== null && f.updated_at < olderThan,
      );
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
  };
  return {
    deps, forwards, intents, paidWebhooks, campaignWebhooks, sleeps,
    statusCalls: () => statusCalls,
  };
}

describe('pollForwardConfirmation (primary path)', () => {
  it('paid + merchant webhook fire on CONFIRMED, not on broadcast', async () => {
    const h = makeDeps({
      statuses: ['pending', 'confirmed'],
      forwards: [forwardRow()],
      intents: [intentRow()],
      orders: [orderRow()],
    });
    const outcome = await pollForwardConfirmation(h.deps, forwardRow());
    expect(outcome).toBe('confirmed');
    expect(h.forwards.get(1)!.status).toBe('confirmed');
    const intent = h.intents.get('sid123abc')!;
    expect(intent.state).toBe('paid');
    expect(intent.forward_tx_hash).toBe('0xfwd1');
    expect(intent.amount_received_cents).toBe(500);
    expect(h.paidWebhooks).toHaveLength(1);
    // SEPA sender passthrough from the D1 order row (cron/read path parity).
    expect(h.paidWebhooks[0].sender).toEqual({
      iban: 'HR1210010051863000160',
      name: 'Pero Perić',
    });
  });

  it('still-pending TX (poll window exhausted) → NOT paid, NO webhook, stays submitted', async () => {
    const h = makeDeps({
      statuses: ['pending'],
      forwards: [forwardRow()],
      intents: [intentRow()],
      orders: [orderRow()],
    });
    const outcome = await pollForwardConfirmation(h.deps, forwardRow());
    expect(outcome).toBe('timeout');
    expect(h.forwards.get(1)!.status).toBe('submitted'); // cron will settle
    expect(h.intents.get('sid123abc')!.state).toBe('pending');
    expect(h.paidWebhooks).toHaveLength(0);
    expect(h.sleeps).toHaveLength(CONFIRM_POLL_DELAYS_MS.length);
  });

  it('on-chain revert → forward failed, intent NOT paid, NO webhook', async () => {
    const h = makeDeps({
      statuses: ['failed'],
      forwards: [forwardRow()],
      intents: [intentRow()],
      orders: [orderRow()],
    });
    const outcome = await pollForwardConfirmation(h.deps, forwardRow());
    expect(outcome).toBe('failed');
    expect(h.forwards.get(1)!.status).toBe('failed');
    expect(h.forwards.get(1)!.error).toBe('onchain_revert');
    expect(h.intents.get('sid123abc')!.state).toBe('pending');
    expect(h.paidWebhooks).toHaveLength(0);
    expect(h.campaignWebhooks).toHaveLength(0);
  });
});

describe('settleConfirmedForward (single-fire idempotency)', () => {
  it('double confirmation (primary + cron race) → paid once, webhook once', async () => {
    const h = makeDeps({
      forwards: [forwardRow()],
      intents: [intentRow()],
      orders: [orderRow()],
    });
    expect(await settleConfirmedForward(h.deps, forwardRow())).toBe(true);
    expect(await settleConfirmedForward(h.deps, forwardRow())).toBe(false);
    expect(h.intents.get('sid123abc')!.state).toBe('paid');
    expect(h.paidWebhooks).toHaveLength(1);
  });

  it('self_target_noop row (inserted as confirmed, never submitted) is not re-settled', async () => {
    const noop = forwardRow({ status: 'confirmed', tx_hash: null, error: 'self_target_noop' });
    const h = makeDeps({ forwards: [noop], intents: [intentRow()], orders: [orderRow()] });
    expect(await settleConfirmedForward(h.deps, noop)).toBe(false);
    expect(h.paidWebhooks).toHaveLength(0);
  });

  it('late confirmation after intent expiry → forward confirmed but intent NOT resurrected, no webhook', async () => {
    const h = makeDeps({
      forwards: [forwardRow()],
      intents: [intentRow({ state: 'expired' })],
      orders: [orderRow()],
    });
    expect(await settleConfirmedForward(h.deps, forwardRow())).toBe(true);
    expect(h.forwards.get(1)!.status).toBe('confirmed'); // money still routed
    expect(h.intents.get('sid123abc')!.state).toBe('expired');
    expect(h.paidWebhooks).toHaveLength(0);
  });

  it('cmp: campaign forward → contribution webhook once, on confirmation only', async () => {
    const cmpForward = forwardRow({
      sid: null,
      memo_prefix: 'cmp',
      target_address: '0x2222222222222222222222222222222222222222',
    });
    const cmpOrder = orderRow({
      memo: 'cmp:0x2222222222222222222222222222222222222222?id=camp42',
    });
    const h = makeDeps({ forwards: [cmpForward], orders: [cmpOrder] });
    expect(await settleConfirmedForward(h.deps, cmpForward)).toBe(true);
    expect(await settleConfirmedForward(h.deps, cmpForward)).toBe(false);
    expect(h.campaignWebhooks).toHaveLength(1);
    expect(h.campaignWebhooks[0]).toMatchObject({
      campaignId: 'camp42',
      orderId: 'ord-1',
      amountCents: 500,
      forwardTxHash: '0xfwd1',
      targetAddress: '0x2222222222222222222222222222222222222222',
      senderIban: 'HR1210010051863000160',
    });
    expect(h.paidWebhooks).toHaveLength(0); // no sid → no intent.paid event
  });
});

describe('settleNonRoutedPaid (direct mint / self-target — no forward TX)', () => {
  it('paid keys off order processed; webhook fires once', async () => {
    const h = makeDeps({ intents: [intentRow()] });
    const args = {
      sid: 'sid123abc',
      orderId: 'ord-1',
      forwardId: 7,
      amountCents: 500,
      sender: { iban: 'HR12', name: 'Pero' },
    };
    expect(await settleNonRoutedPaid(h.deps, args)).toBe(true);
    const intent = h.intents.get('sid123abc')!;
    expect(intent.state).toBe('paid');
    expect(intent.forward_tx_hash).toBeNull(); // no on-chain forward hop
    expect(h.paidWebhooks).toHaveLength(1);
    // Duplicate order.updated replay → single-fire.
    expect(await settleNonRoutedPaid(h.deps, args)).toBe(false);
    expect(h.paidWebhooks).toHaveLength(1);
  });
});

describe('reconcileSubmittedForwards (cron backstop)', () => {
  it('confirms + fails stale submitted forwards through the same settle path', async () => {
    const fwdA = forwardRow({ id: 1, order_id: 'ord-1', sid: 'sid123abc', tx_hash: '0xfwd1' });
    const fwdB = forwardRow({ id: 2, order_id: 'ord-2', sid: 'sidZZZ999', tx_hash: '0xfwd2' });
    const h = makeDeps({
      statuses: ['confirmed', 'failed'],
      forwards: [fwdA, fwdB],
      intents: [intentRow({ sid: 'sid123abc' }), intentRow({ sid: 'sidZZZ999' })],
      orders: [orderRow({ id: 'ord-1' }), orderRow({ id: 'ord-2' })],
    });
    const r = await reconcileSubmittedForwards(h.deps, NOW);
    expect(r).toEqual({ checked: 2, confirmed: 1, failed: 1 });
    expect(h.forwards.get(1)!.status).toBe('confirmed');
    expect(h.intents.get('sid123abc')!.state).toBe('paid');
    expect(h.forwards.get(2)!.status).toBe('failed');
    expect(h.intents.get('sidZZZ999')!.state).toBe('pending');
    expect(h.paidWebhooks).toHaveLength(1);
    expect(h.paidWebhooks[0].sid).toBe('sid123abc');
  });

  it('empty submitted set → no-op, no chain calls', async () => {
    const h = makeDeps({ forwards: [forwardRow({ status: 'confirmed' })] });
    const r = await reconcileSubmittedForwards(h.deps, NOW);
    expect(r).toEqual({ checked: 0, confirmed: 0, failed: 0 });
    expect(h.statusCalls()).toBe(0);
  });

  it('skips forwards younger than the min-age threshold (primary poll still racing)', async () => {
    const fresh = forwardRow({ updated_at: NOW - 5 });
    const h = makeDeps({ statuses: ['confirmed'], forwards: [fresh], intents: [intentRow()] });
    const r = await reconcileSubmittedForwards(h.deps, NOW);
    expect(r.checked).toBe(0);
    expect(h.forwards.get(1)!.status).toBe('submitted');
  });
});
