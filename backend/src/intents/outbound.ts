import type { Env } from '../types';
import type { MoneriumOrder } from '../monerium/types';
import { parseAmountCentsFromOrder } from '../monerium/orderState';
import type { PaymentIntentRow } from './db';
import { enqueueWebhook, type OutboxEvent } from './outbox';

/// Outbound merchant webhooks. pinka.finance consumes them through the
/// domovina-api `pinka-webhook` edge function (unknown types → 200 ignored).
///
/// Delivery is durable: every event goes through `webhook_outbox`
/// (./outbox.ts) — persisted, attempted once immediately, retried by the cron.
///
/// Signing mirrors the INBOUND Monerium scheme (Standard Webhooks / svix):
///   headers: webhook-id, webhook-timestamp, webhook-signature: `v1,<base64>`
///   signed payload: `${id}.${timestamp}.${rawBody}`
///
/// Event lifecycle for one SEPA payment (card analogy in brackets):
///
///   payment.received   rcv_<orderId>  Monerium holds the SEPA funds, ~1 s
///                                     after the payer's bank sent them
///                                     [authorisation — safe to show "paid"]
///   intent.paid        int_<sid>      EURe minted + forwarded, confirmed
///                                     on-chain [settlement]
///   payment.late       late_<sid>     same as intent.paid, but the intent had
///                                     already expired
///   payment.rejected   rej_<orderId>  Monerium refused the order; funds go
///                                     back to the payer [decline/reversal]
///   contribution.sepa  cmp_<orderId>  permanent campaign QR settlement
///   forward.blocked    blk_<orderId>  our payout whitelist refused the target
///
/// Every `webhook-id` is unique per (event type, subject) — receivers dedup on
/// it, so two different events must never share an id. The historical ids
/// (int_/cmp_/blk_) are kept byte-identical for existing receivers.
///
/// Every payload carries `event_id` (= webhook-id) and `occurred_at` (ISO).

function nowIso(): string {
  return new Date().toISOString();
}

export async function emitIntentPaidWebhook(
  env: Env,
  intent: PaymentIntentRow,
  sender?: { iban: string | null; name: string | null },
): Promise<void> {
  const id = `int_${intent.sid}`;
  await enqueueWebhook(env, {
    id,
    type: 'intent.paid',
    tenantId: intent.tenant_id,
    payload: {
      type: 'intent.paid',
      event_id: id,
      occurred_at: nowIso(),
      ...settledIntentFields(intent, sender),
    },
  });
}

/// A payment that settled AFTER its intent expired. Separate type (and id) so
/// receivers that treat expiry as final are not surprised, while receivers
/// that want to credit late money can.
export async function emitPaymentLateWebhook(
  env: Env,
  intent: PaymentIntentRow,
  sender?: { iban: string | null; name: string | null },
): Promise<void> {
  const id = `late_${intent.sid}`;
  await enqueueWebhook(env, {
    id,
    type: 'payment.late',
    tenantId: intent.tenant_id,
    payload: {
      type: 'payment.late',
      event_id: id,
      occurred_at: nowIso(),
      ...settledIntentFields(intent, sender),
    },
  });
}

function settledIntentFields(
  intent: PaymentIntentRow,
  sender?: { iban: string | null; name: string | null },
): Record<string, unknown> {
  return {
    sid: intent.sid,
    state: intent.state,
    amount_cents: intent.amount_cents,
    amount_received_cents: intent.amount_received_cents,
    currency: intent.currency,
    target_address: intent.target_address,
    monerium_order_id: intent.monerium_order_id,
    forward_tx_hash: intent.forward_tx_hash,
    paid_at: intent.paid_at,
    // SEPA sender (Monerium counterpart) → merchant derives bank-verified /
    // KYC-name-match. PII: the merchant must not expose it publicly.
    sender_iban: sender?.iban ?? null,
    sender_name: sender?.name ?? null,
    metadata: intent.metadata_json ? safeParse(intent.metadata_json) : null,
  };
}

/// Correlation for a Monerium order: which intent / campaign it pays.
export interface OrderCorrelation {
  sid: string | null;
  campaignId: string | null;
  tenantId: string | null;
  /// Has an order from this payer IBAN been processed before? Monerium only
  /// reports its screening verdict (`meta.evaluation`) once the order is
  /// processed, but in production 5/5 first payments from a new IBAN were held
  /// for manual review ("counterpart is not screened", 1 min – 8 h) and 44/44
  /// repeat payers minted in seconds. null = unknown (no IBAN on the order).
  knownPayer: boolean | null;
}

/// Pure: the lifecycle event a Monerium issue order implies right now, or
/// null when there is nothing to tell a merchant (redeem order, or no intent /
/// campaign to correlate on).
export function buildOrderLifecycleEvent(
  order: MoneriumOrder,
  corr: OrderCorrelation,
): OutboxEvent | null {
  if (order.kind !== 'issue') return null;
  if (!corr.sid && !corr.campaignId) return null;
  const state = order.state ?? order.meta?.state;
  const base = {
    sid: corr.sid,
    campaign_id: corr.campaignId,
    monerium_order_id: order.id,
    amount_received_cents: parseAmountCentsFromOrder(order),
    currency: order.currency ?? 'eur',
  };
  if (state === 'rejected') {
    const id = `rej_${order.id}`;
    const reason = order.meta?.rejectedReason;
    return {
      id,
      type: 'payment.rejected',
      tenantId: corr.tenantId,
      payload: {
        type: 'payment.rejected',
        event_id: id,
        occurred_at: order.meta?.processedAt ?? nowIso(),
        ...base,
        reason: typeof reason === 'string' ? reason : null,
        // Monerium returns rejected SEPA funds to the payer.
        funds_location: 'returned_to_payer',
      },
    };
  }
  const id = `rcv_${order.id}`;
  return {
    id,
    type: 'payment.received',
    tenantId: corr.tenantId,
    payload: {
      type: 'payment.received',
      event_id: id,
      occurred_at: order.meta?.placedAt ?? nowIso(),
      ...base,
      // Funds are held by Monerium (regulated EMI); EURe not minted yet.
      funds_location: 'monerium',
      settlement: 'pending',
      review_expected: corr.knownPayer === null ? null : !corr.knownPayer,
    },
  };
}

export async function emitOrderLifecycleWebhook(
  env: Env,
  order: MoneriumOrder,
  corr: OrderCorrelation,
): Promise<void> {
  const evt = buildOrderLifecycleEvent(order, corr);
  if (evt) await enqueueWebhook(env, evt);
}

/// Outbound "contribution.sepa" webhook for the PERMANENT campaign QR (`cmp:`
/// protocol). Unlike `intent.paid`, there is no pre-created intent — every
/// inbound Monerium order to a campaign's permanent QR fires one event, so the
/// receiver records a DISTINCT contribution per payment. Idempotent: webhook-id
/// is stable per Monerium order (`cmp_<orderId>`), and the receiver dedups on
/// `monerium_order_id`.
export async function emitCampaignContributionWebhook(
  env: Env,
  args: {
    campaignId: string;
    orderId: string;
    amountCents: number | null;
    currency: string;
    targetAddress: string;
    forwardTxHash: string | null;
    senderIban?: string | null;
    senderName?: string | null;
  },
): Promise<void> {
  const id = `cmp_${args.orderId}`;
  await enqueueWebhook(env, {
    id,
    type: 'contribution.sepa',
    payload: {
      type: 'contribution.sepa',
      event_id: id,
      occurred_at: nowIso(),
      campaign_id: args.campaignId,
      monerium_order_id: args.orderId,
      amount_received_cents: args.amountCents,
      currency: args.currency,
      target_address: args.targetAddress,
      forward_tx_hash: args.forwardTxHash,
      // SEPA sender (Monerium counterpart) → merchant derives bank-verified.
      sender_iban: args.senderIban ?? null,
      sender_name: args.senderName ?? null,
    },
  });
}

/// Outbound "forward.blocked" webhook. Fires when the tenant payout whitelist
/// refused a destination, so the merchant learns that money arrived but was
/// NOT forwarded — instead of the payment silently hanging in `minted`.
///
/// The EURe stays in the MPT Safe; this event is informational and carries no
/// payer PII.
export async function emitForwardBlockedWebhook(
  env: Env,
  args: {
    reason: string;
    orderId: string;
    sid: string | null;
    campaignId: string | null;
    targetAddress: string | null;
    amountCents: number | null;
    tenantId: string | null;
  },
): Promise<void> {
  const id = `blk_${args.orderId}`;
  await enqueueWebhook(env, {
    id,
    type: 'forward.blocked',
    tenantId: args.tenantId,
    payload: {
      type: 'forward.blocked',
      event_id: id,
      occurred_at: nowIso(),
      reason: args.reason,
      monerium_order_id: args.orderId,
      sid: args.sid,
      campaign_id: args.campaignId,
      target_address: args.targetAddress,
      amount_cents: args.amountCents,
      tenant_id: args.tenantId,
      // The funds are safe, just not forwarded — say so explicitly so the
      // receiver never renders this as a loss.
      funds_location: 'mpt_safe',
    },
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
