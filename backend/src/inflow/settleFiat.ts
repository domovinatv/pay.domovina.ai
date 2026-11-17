import type { Env } from '../types';
import type { MoneriumOrder } from '../monerium/types';
import type { CreditEvent } from './creditEvent';
import { insertForward, upsertMoneriumOrder } from '../monerium/db';
import { makeConfirmDeps, settleNonRoutedPaid } from '../intents/confirm';
import { emitOrderLifecycleWebhook } from '../intents/outbound';
import { publishIntentChange } from '../intents/stream';
import { getIntent } from '../intents/db';

/// Settlement for a `fiat_notify` receiving account (ADR 0032 §3): the money
/// is already on the TENANT's own account, there is nothing to mint or move.
///
/// Until `intent_settlements` exists (ADR 0032 §4) this reuses the exact path
/// the sandbox simulation uses (ADR 0024, `sandbox/simulate.ts`): a synthetic
/// order row + a confirmed forward row without a tx, then the production
/// `settleNonRoutedPaid` decides paid / underpaid / late. The status timeline,
/// receipts, SSE and every merchant webhook therefore behave exactly as for a
/// Monerium payment. The order id prefix (`<provider>_`) and the forward error
/// (`fiat_notify`) tell the rows apart.

export const FIAT_FORWARD_ERROR = 'fiat_notify';

export function syntheticOrderId(ev: Pick<CreditEvent, 'provider' | 'providerRef'>): string {
  return `${ev.provider}_${ev.providerRef.split(':')[0]}`;
}

function iso(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

export function buildSyntheticOrder(
  ev: CreditEvent,
  targetAddress: string,
  state: 'pending' | 'processed',
): MoneriumOrder {
  return {
    id: syntheticOrderId(ev),
    kind: 'issue',
    profile: ev.provider,
    address: targetAddress,
    chain: 'gnosis',
    currency: 'eur',
    amount: (ev.amountCents / 100).toFixed(2),
    memo: ev.remittance ?? undefined,
    state,
    counterpart: ev.debtorAccount
      ? { identifier: { standard: 'iban', iban: ev.debtorAccount }, details: { name: ev.debtorName ?? undefined } }
      : { details: { name: ev.debtorName ?? undefined } },
    meta: {
      state,
      placedAt: iso(ev.occurredAt),
      processedAt: state === 'processed' ? iso(ev.occurredAt) : undefined,
      txHashes: [],
      source: ev.provider,
      scheme: ev.scheme,
    },
  } as MoneriumOrder;
}

/// Returns the synthetic order id the intent was settled with.
export async function settleFiatCredit(env: Env, ev: CreditEvent, sid: string): Promise<string | null> {
  const intent = await getIntent(env, sid);
  if (!intent) return null;
  const orderId = syntheticOrderId(ev);
  const corr = { sid, campaignId: null, tenantId: ev.tenantId, knownPayer: null };

  // 1. payment.received — the card-like "approved" moment.
  const received = buildSyntheticOrder(ev, intent.target_address, 'pending');
  await upsertMoneriumOrder(env, received, ev.tenantId);
  await emitOrderLifecycleWebhook(env, received, corr);

  // 2. Booked on the tenant's account = final for fiat_notify.
  const processed = buildSyntheticOrder(ev, intent.target_address, 'processed');
  await upsertMoneriumOrder(env, processed, ev.tenantId);
  const forwardId = await insertForward(env, {
    orderId,
    targetAddress: intent.target_address,
    amountWei: '0',
    amountCents: ev.amountCents,
    sid,
    memoPrefix: ev.provider,
    status: 'confirmed',
    error: FIAT_FORWARD_ERROR,
    tenantId: ev.tenantId,
  });
  await settleNonRoutedPaid(makeConfirmDeps(env), {
    sid,
    orderId,
    forwardId,
    amountCents: ev.amountCents,
    sender: { iban: ev.debtorAccount, name: ev.debtorName },
  });
  await publishIntentChange(env, sid);
  return orderId;
}
