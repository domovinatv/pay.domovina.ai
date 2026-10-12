import type { Env } from '../types';
import type { MoneriumOrder } from '../monerium/types';
import { insertForward, recordMoneriumWebhookEvent, upsertMoneriumOrder } from '../monerium/db';
import { makeConfirmDeps, settleNonRoutedPaid } from '../intents/confirm';
import { emitOrderLifecycleWebhook } from '../intents/outbound';
import { publishIntentChange } from '../intents/stream';
import { getIntent, type PaymentIntentRow } from '../intents/db';
import { intentReference } from '../tenants/rail';

/// Simulated payment for a sandbox intent (ADR 0024 D4). Nothing here is
/// parallel to production: a synthetic Monerium order goes through the same
/// order store, lifecycle webhooks, forward row and settle path
/// (settleNonRoutedPaid → paid / underpaid / late) as a real payment, so the
/// status timeline, SSE and every merchant event look exactly like the real
/// thing. Only the order id (`sim_…`), the forward error ('simulated') and
/// the tenant (sandbox = 1, no rail) tell them apart.

export type SimOutcome = 'paid' | 'received' | 'underpaid' | 'late' | 'rejected';
export const SIM_OUTCOMES: readonly SimOutcome[] = ['paid', 'received', 'underpaid', 'late', 'rejected'];

/// Public example IBAN (ISO 13616 / ECBS), never a real account.
export const SIM_PAYER_IBAN = 'DE89370400440532013000';
export const SIM_PAYER_NAME = 'Sandbox Payer';
export const SIM_ORDER_PREFIX = 'sim_';
export const SIM_FORWARD_ERROR = 'simulated';
/// Simulations per sandbox tenant per 24 h.
export const SIM_PER_TENANT_PER_DAY = 100;

export type SimResult =
  | { ok: true; outcome: SimOutcome; orderId: string; intent: PaymentIntentRow }
  | { ok: false; error: 'already_settled' | 'already_rejected' | 'invalid_amount' };

function iso(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

function randomSuffix(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/// Amount the simulated payer sends. Underpaid without an explicit amount =
/// the intent amount minus 1 € (or half, below 2 €).
export function simulatedAmountCents(intentCents: number, outcome: SimOutcome, requested: number | null): number | null {
  if (requested !== null) return requested > 0 ? requested : null;
  if (outcome !== 'underpaid') return intentCents;
  return intentCents >= 200 ? intentCents - 100 : Math.max(1, Math.floor(intentCents / 2));
}

function buildOrder(
  intent: PaymentIntentRow,
  orderId: string,
  amountCents: number,
  state: 'pending' | 'processed' | 'rejected',
  placedAt: number,
): MoneriumOrder {
  const t = Math.floor(Date.now() / 1000);
  return {
    id: orderId,
    kind: 'issue',
    profile: 'sandbox',
    address: intent.target_address,
    chain: 'gnosis',
    currency: 'eur',
    amount: (amountCents / 100).toFixed(2),
    memo: intentReference(null, intent),
    state,
    counterpart: {
      identifier: { standard: 'iban', iban: SIM_PAYER_IBAN },
      details: { name: SIM_PAYER_NAME },
    },
    meta: {
      state,
      placedAt: iso(placedAt),
      processedAt: state === 'pending' ? undefined : iso(t),
      txHashes: [],
      ...(state === 'rejected' ? { rejectedReason: 'Simulated rejection (sandbox)' } : {}),
    },
  } as unknown as MoneriumOrder;
}

async function recordEvent(env: Env, order: MoneriumOrder, intent: PaymentIntentRow, amountCents: number): Promise<void> {
  await recordMoneriumWebhookEvent(env, {
    orderId: order.id,
    eventType: `simulated.order.${order.state}`,
    signatureOk: true,
    payload: JSON.stringify({ simulated: true, order }),
    sidExtracted: intent.sid,
    amountCents,
    currency: 'eur',
    processingNote: 'simulated (sandbox, ADR 0024)',
    tenantId: intent.tenant_id,
  });
}

/// The caller has already checked that `intent` belongs to a sandbox tenant.
export async function simulatePayment(
  env: Env,
  intent: PaymentIntentRow,
  outcome: SimOutcome,
  requestedCents: number | null,
): Promise<SimResult> {
  if (intent.monerium_order_id) return { ok: false, error: 'already_settled' };
  const amountCents = simulatedAmountCents(intent.amount_cents, outcome, requestedCents);
  if (amountCents === null) return { ok: false, error: 'invalid_amount' };

  // A payment simulated as `received` earlier is still in flight: advance that
  // order instead of opening a second one. A rejected one is final.
  const open = await env.DB.prepare(
    `SELECT id, state, placed_at FROM monerium_orders
      WHERE tenant_id = ? AND id LIKE ? ESCAPE '\\'
      ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(intent.tenant_id, `sim\\_${intent.sid}\\_%`)
    .first<{ id: string; state: string; placed_at: string | null }>();
  if (open?.state === 'rejected') return { ok: false, error: 'already_rejected' };
  if (open?.state === 'processed') return { ok: false, error: 'already_settled' };
  const resumed = open && (open.state === 'pending' || open.state === 'placed');
  const orderId = resumed ? open.id : `${SIM_ORDER_PREFIX}${intent.sid}_${randomSuffix()}`;
  const placedAt = resumed && open.placed_at ? Math.floor(Date.parse(open.placed_at) / 1000) : Math.floor(Date.now() / 1000);
  const corr = { sid: intent.sid, campaignId: null, tenantId: intent.tenant_id, knownPayer: true };

  // 1. Monerium holds the funds → payment.received (once per order).
  if (!resumed) {
    const received = buildOrder(intent, orderId, amountCents, 'pending', placedAt);
    await upsertMoneriumOrder(env, received, intent.tenant_id);
    await recordEvent(env, received, intent, amountCents);
    await emitOrderLifecycleWebhook(env, received, corr);
  }

  if (outcome === 'received') {
    await publishIntentChange(env, intent.sid);
    return { ok: true, outcome, orderId, intent: (await getIntent(env, intent.sid)) ?? intent };
  }

  if (outcome === 'rejected') {
    const rejected = buildOrder(intent, orderId, amountCents, 'rejected', placedAt);
    await upsertMoneriumOrder(env, rejected, intent.tenant_id);
    await recordEvent(env, rejected, intent, amountCents);
    await emitOrderLifecycleWebhook(env, rejected, corr);
    await publishIntentChange(env, intent.sid);
    return { ok: true, outcome, orderId, intent: (await getIntent(env, intent.sid)) ?? intent };
  }

  // `late`: the intent expires first, exactly what a payment after the
  // deadline meets in production.
  if (outcome === 'late') {
    await env.DB.prepare(`UPDATE payment_intents SET state = 'expired' WHERE sid = ? AND state = 'pending'`)
      .bind(intent.sid)
      .run();
  }

  // 2. Minted and (in direct style) already at the target: a confirmed
  // forward row without a tx, then the production settle path decides
  // paid / underpaid / late from the amount and the intent state.
  const processed = buildOrder(intent, orderId, amountCents, 'processed', placedAt);
  await upsertMoneriumOrder(env, processed, intent.tenant_id);
  await recordEvent(env, processed, intent, amountCents);
  const forwardId = await insertForward(env, {
    orderId,
    targetAddress: intent.target_address,
    amountWei: '0',
    amountCents,
    sid: intent.sid,
    memoPrefix: 'sim',
    status: 'confirmed',
    error: SIM_FORWARD_ERROR,
    tenantId: intent.tenant_id,
  });
  await settleNonRoutedPaid(makeConfirmDeps(env), {
    sid: intent.sid,
    orderId,
    forwardId,
    amountCents,
    sender: { iban: SIM_PAYER_IBAN, name: SIM_PAYER_NAME },
  });
  return { ok: true, outcome, orderId, intent: (await getIntent(env, intent.sid)) ?? intent };
}
