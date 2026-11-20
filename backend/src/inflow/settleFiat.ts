import type { Env } from '../types';
import type { MoneriumOrder } from '../monerium/types';
import type { CreditEvent, CreditFinality, CreditProvider } from './creditEvent';
import { moneriumOrderRow, type MoneriumOrderRow } from '../monerium/db';
import { makeConfirmDeps, settleFiatPaid } from '../intents/confirm';
import { emitOrderLifecycleWebhook } from '../intents/outbound';
import { publishIntentChange } from '../intents/stream';
import { getIntent, type PaymentIntentRow } from '../intents/db';
import { intentProvider, isFiatProvider } from './provider';

/// Settlement for a `fiat_notify` receiving account (ADR 0032 §3): the money
/// is already on the TENANT's own account, there is nothing to mint or move.
///
/// The settlement is the intent claim + its `intent_settlements` row (ADR 0032
/// §4), named by `syntheticOrderId` (`<provider>_<txId>`), plus the credit
/// event the adapter records. Nothing goes into `monerium_orders` or
/// `monerium_forwards` (S3 of the Swan close-out, 2026-11-20; until then a
/// synthetic order + a `fiat_notify` forward were written). The production
/// `flipPaidAndNotify` decides paid / underpaid / late, so every merchant
/// webhook keeps its id and payload: `buildSyntheticOrder` still shapes the
/// `payment.received` event, it is just no longer stored.

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

/// Returns the settlement ref (`<provider>_<txId>`) the intent was settled with.
export async function settleFiatCredit(env: Env, ev: CreditEvent, sid: string): Promise<string | null> {
  const intent = await getIntent(env, sid);
  if (!intent) return null;
  const ref = syntheticOrderId(ev);
  const corr = { sid, campaignId: null, tenantId: ev.tenantId, knownPayer: null };

  // 1. payment.received — the card-like "approved" moment (`rcv_<ref>`).
  await emitOrderLifecycleWebhook(env, buildSyntheticOrder(ev, intent.target_address, 'pending'), corr);

  // 2. Booked on the tenant's account = final for fiat_notify.
  await settleFiatPaid(makeConfirmDeps(env), {
    sid,
    settlementRef: ref,
    amountCents: ev.amountCents,
    sender: { iban: ev.debtorAccount, name: ev.debtorName },
  });
  await publishIntentChange(env, sid);
  return ref;
}

// ---------------------------------------------------------------------------
// Reading a fiat settlement (S2 of the Swan close-out, ADR 0032 §4)
// ---------------------------------------------------------------------------
//
// Readers (status timeline, admin) take a fiat intent's settlement from
// `intent_settlements` + its booked `credit_events` row. The view below is
// built with the same `buildSyntheticOrder` + `moneriumOrderRow` that shaped
// the synthetic order row written until S3, and comes out field for field the
// same (only `updated_at` becomes the settlement time).

interface FiatSettlementRow {
  settlement_ref: string;
  settled_at: number;
  ev_provider: string;
  provider_ref: string;
  tenant_id: string;
  receiving_account_id: number | null;
  receiving_iban: string | null;
  amount_cents: number;
  currency: string;
  remittance: string | null;
  end_to_end_id: string | null;
  debtor_name: string | null;
  debtor_account: string | null;
  scheme: 'sepa' | 'sepa_inst' | null;
  finality: CreditFinality;
  occurred_at: number;
}

export interface FiatSettlement {
  settlementRef: string;
  settledAt: number;
  event: CreditEvent;
}

/// The credit event a fiat intent was settled with. `credit_event_id` is set
/// by recordMatch right after the settle; until then the booked event is
/// found by its key, which `syntheticOrderId` derives the ref from
/// (`<provider>_<txId>` ⇔ provider_ref `<txId>:booked`).
export async function loadFiatSettlement(env: Env, sid: string): Promise<FiatSettlement | null> {
  const row = await env.DB.prepare(
    `SELECT s.settlement_ref, s.created_at AS settled_at, ce.provider AS ev_provider, ce.provider_ref, ce.tenant_id,
            ce.receiving_account_id, ce.receiving_iban, ce.amount_cents, ce.currency, ce.remittance,
            ce.end_to_end_id, ce.debtor_name, ce.debtor_account, ce.scheme, ce.finality, ce.occurred_at
       FROM intent_settlements s
       JOIN credit_events ce ON ce.id = COALESCE(
              s.credit_event_id,
              (SELECT c.id FROM credit_events c
                WHERE c.provider = s.provider
                  AND c.provider_ref = substr(s.settlement_ref, length(s.provider) + 2) || ':booked'))
      WHERE s.sid = ?`,
  )
    .bind(sid)
    .first<FiatSettlementRow>();
  if (!row) return null;
  return {
    settlementRef: row.settlement_ref,
    settledAt: row.settled_at,
    event: {
      provider: row.ev_provider as CreditProvider,
      providerRef: row.provider_ref,
      tenantId: row.tenant_id,
      receivingAccountId: row.receiving_account_id,
      receivingIban: row.receiving_iban,
      amountCents: row.amount_cents,
      currency: 'EUR',
      remittance: row.remittance,
      endToEndId: row.end_to_end_id,
      debtorName: row.debtor_name,
      debtorAccount: row.debtor_account,
      scheme: row.scheme,
      finality: row.finality,
      occurredAt: row.occurred_at,
      raw: null,
    },
  };
}

/// The settled fiat intent's payment as an order row, for readers that still
/// take one (computeStage, admin detail). Null for a non-fiat intent or one
/// without a settlement; the caller then reads as before.
export async function fiatSettlementOrder(
  env: Env,
  intent: Pick<PaymentIntentRow, 'sid' | 'provider' | 'target_address'>,
): Promise<MoneriumOrderRow | null> {
  if (!isFiatProvider(intentProvider(intent))) return null;
  const fs = await loadFiatSettlement(env, intent.sid);
  if (!fs) return null;
  const order = buildSyntheticOrder(fs.event, intent.target_address, 'processed');
  // The settlement names the payment; a ref that does not match the event
  // means the row was not written by settleFiatCredit — read as before.
  if (order.id !== fs.settlementRef) return null;
  return moneriumOrderRow(order, fs.event.tenantId, fs.settledAt);
}
