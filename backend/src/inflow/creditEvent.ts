import type { Env } from '../types';

/// ADR 0032: a provider-neutral "money arrived on a receiving account" event.
/// Adapters (verify + normalize) produce it; the inbox, matcher and settlement
/// never look at the provider's own payload shape again.

export type CreditProvider = 'monerium' | 'swan' | 'wise' | 'lhv' | 'bank_push' | 'ais' | 'sandbox';
export type CreditFinality = 'notified' | 'booked' | 'onchain_confirmed';

export interface CreditEvent {
  provider: CreditProvider;
  /// Idempotency key within the provider (Swan: `<transactionId>:<finality>`).
  providerRef: string;
  tenantId: string;
  receivingAccountId: number | null;
  receivingIban: string | null;
  amountCents: number;
  currency: 'EUR';
  /// Unstructured remittance — carries the sid or short_ref.
  remittance: string | null;
  endToEndId: string | null;
  debtorName: string | null;
  debtorAccount: string | null;
  scheme: 'sepa' | 'sepa_inst' | null;
  finality: CreditFinality;
  occurredAt: number;
  raw: unknown;
}

export interface CreditEventRow {
  id: number;
  provider: string;
  provider_ref: string;
  tenant_id: string;
  matched_sid: string | null;
  matched_by: string | null;
  match_note: string | null;
  settlement_ref: string | null;
}

/// Decimal string ("12.34", "5", "0.5") → cents, or null for anything else.
export function decimalToCents(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/// Insert into the inbox. Returns the new row id, or null when this
/// (provider, provider_ref) is already there — a redelivery.
export async function insertCreditEvent(env: Env, ev: CreditEvent): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    `INSERT INTO credit_events
       (provider, provider_ref, tenant_id, receiving_account_id, receiving_iban, amount_cents, currency,
        remittance, end_to_end_id, debtor_name, debtor_account, scheme, finality, occurred_at, raw, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, provider_ref) DO NOTHING`,
  )
    .bind(
      ev.provider,
      ev.providerRef,
      ev.tenantId,
      ev.receivingAccountId,
      ev.receivingIban,
      ev.amountCents,
      ev.currency,
      ev.remittance,
      ev.endToEndId,
      ev.debtorName,
      ev.debtorAccount,
      ev.scheme,
      ev.finality,
      ev.occurredAt,
      JSON.stringify(ev.raw ?? null),
      now,
    )
    .run();
  if ((res.meta?.changes ?? 0) === 0) return null;
  return Number(res.meta?.last_row_id ?? 0) || null;
}

export async function recordMatch(
  env: Env,
  id: number,
  args: { sid: string | null; by: string | null; note: string | null; settlementRef: string | null },
): Promise<void> {
  const update = env.DB.prepare(
    `UPDATE credit_events SET matched_sid = ?, matched_by = ?, match_note = ?, settlement_ref = ? WHERE id = ?`,
  ).bind(args.sid, args.by, args.note, args.settlementRef, id);
  if (!args.settlementRef) {
    await update.run();
    return;
  }
  // ADR 0032 §4: the settlement row may already exist (a fiat settle runs
  // before its match is recorded; a Monerium cron reconcile can settle before
  // the webhook's inbox write). Link it to this event if it has none yet.
  await env.DB.batch([
    update,
    env.DB.prepare(
      `UPDATE intent_settlements SET credit_event_id = ? WHERE settlement_ref = ? AND credit_event_id IS NULL`,
    ).bind(id, args.settlementRef),
  ]);
}

export async function getCreditEvent(env: Env, provider: string, providerRef: string): Promise<CreditEventRow | null> {
  return env.DB.prepare(
    `SELECT id, provider, provider_ref, tenant_id, matched_sid, matched_by, match_note, settlement_ref
       FROM credit_events WHERE provider = ? AND provider_ref = ?`,
  )
    .bind(provider, providerRef)
    .first<CreditEventRow>();
}
