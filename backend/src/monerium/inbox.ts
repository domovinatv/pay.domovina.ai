import type { Env } from '../types';
import type { MoneriumOrder } from './types';
import { insertCreditEvent, recordMatch, type CreditEvent, type CreditFinality } from '../inflow/creditEvent';
import { orderState, parseAmountCents } from './orderState';

/// ADR 0032 redoslijed 1: a verified Monerium `issue` order is also written to
/// the provider-neutral inbox (`credit_events`), and a failure here never fails
/// the webhook. Matching is `inflow/matcher.ts` (`matchMoneriumOrder`), the
/// same core as fiat; forward.ts executes it and writes the outcome back onto
/// the `booked` event (`recordMoneriumMatch`).
///
/// Finality (ADR 0032 §2): `placed`/`pending` → `notified`, `processed` →
/// `booked`. `rejected` and `redeem` orders are not money in, so no event.
/// One row per (order, finality): Monerium's retries and the
/// created/updated pair collapse on UNIQUE(provider, provider_ref).

export function moneriumFinality(order: MoneriumOrder): CreditFinality | null {
  if (order.kind !== 'issue') return null;
  const state = orderState(order);
  if (state === 'processed') return 'booked';
  if (state === 'placed' || state === 'pending') return 'notified';
  return null;
}

function unix(iso: string | undefined, fallback: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : fallback;
}

export function moneriumCreditEvent(order: MoneriumOrder, tenantId: string, nowUnix: number): CreditEvent | null {
  const finality = moneriumFinality(order);
  if (!finality) return null;
  if ((order.currency ?? '').toLowerCase() !== 'eur') return null;
  const amountCents = parseAmountCents(order.amount);
  if (amountCents === null) return null;
  const id = order.counterpart?.identifier;
  return {
    provider: 'monerium',
    providerRef: `${order.id}:${finality}`,
    tenantId,
    receivingAccountId: null,
    receivingIban: null,
    amountCents,
    currency: 'EUR',
    remittance: order.memo ?? null,
    endToEndId: null,
    debtorName: order.counterpart?.details?.name ?? null,
    debtorAccount: id && id.standard === 'iban' ? id.iban : null,
    scheme: null,
    finality,
    occurredAt: unix(finality === 'booked' ? order.meta?.processedAt : order.meta?.placedAt, nowUnix),
    raw: order,
  };
}

/// `sid` = the reference parsed from the memo; `previewSid` = the stray
/// resolver's read-only guess for a reference-less order. Only a parsed sid
/// counts as a match here; the guess is kept as a note, because the
/// settlement (forward → intent_settlements) is what decides.
export async function recordMoneriumCredit(
  env: Env,
  order: MoneriumOrder,
  tenantId: string,
  hint: { sid: string | null; previewSid: string | null },
): Promise<number | null> {
  const ev = moneriumCreditEvent(order, tenantId, Math.floor(Date.now() / 1000));
  if (!ev) return null;
  const id = await insertCreditEvent(env, ev);
  if (id === null) return null;
  await recordMatch(env, id, {
    sid: hint.sid,
    by: hint.sid ? 'sid' : null,
    note: !hint.sid && hint.previewSid ? `stray_preview: ${hint.previewSid}` : null,
    settlementRef: order.id,
  });
  return id;
}

/// The executed decision for an order, onto its `booked` event: the intent
/// the forward claimed (`by` = sid | short_ref | stray | manual), or no intent
/// with the park reason. No row (inbox write failed, or a cron reconcile
/// forwarded an order the webhook never recorded) = nothing to update.
export async function recordMoneriumMatch(
  env: Env,
  orderId: string,
  m: { sid: string | null; by: string | null; note: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE credit_events SET matched_sid = ?, matched_by = ?, match_note = ?
      WHERE provider = 'monerium' AND provider_ref = ?`,
  )
    .bind(m.sid, m.by, m.note, `${orderId}:booked`)
    .run();
}
