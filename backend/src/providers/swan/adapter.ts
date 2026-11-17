import type { Env } from '../../types';
import type { CreditEvent } from '../../inflow/creditEvent';
import { decimalToCents, insertCreditEvent, recordMatch } from '../../inflow/creditEvent';
import { makeMatcherDeps, matchCreditEvent, type MatchResult } from '../../inflow/matcher';
import { settleFiatCredit } from '../../inflow/settleFiat';
import {
  decryptReceivingAccount,
  listActiveReceivingAccounts,
  timingSafeEqual,
  type ReceivingAccount,
} from '../../inflow/receivingAccounts';
import { sendAlert } from '../../alerts';
import { makeSwanClient, type SwanClient, type SwanTransaction } from './client';

/// Swan adapter (ADR 0032, route `/api/swan/webhook/t/:tenantId`).
///
/// Swan's webhook is a thin notification (`eventType`, `eventId`,
/// `resourceId`, …) with a shared secret in `x-swan-secret`, no body
/// signature. So the webhook is only a TRIGGER: the transaction is always
/// re-read from Swan's API with the tenant's own credentials, and only a
/// credit on the tenant's own Swan account counts. A forged webhook can at
/// most cause that read.

export interface SwanWebhookBody {
  eventType?: string;
  eventId?: string;
  eventDate?: string;
  projectId?: string;
  resourceId?: string;
  retryCount?: number;
}

const INCOMING_TYPES = new Set(['SepaCreditTransferIn', 'SepaInstantCreditTransferIn']);

/// Swan transaction → CreditEvent, or null when it is not an incoming EUR
/// SEPA credit in a state we act on.
export function normalizeSwanTransaction(
  tx: SwanTransaction,
  account: Pick<ReceivingAccount, 'id' | 'tenantId'>,
): CreditEvent | null {
  if (tx.side !== 'Credit' || !INCOMING_TYPES.has(tx.type)) return null;
  if ((tx.amount?.currency ?? '').toUpperCase() !== 'EUR') return null;
  const amountCents = decimalToCents(tx.amount.value);
  if (amountCents === null || amountCents <= 0) return null;
  const status = tx.statusInfo?.status;
  const finality = status === 'Booked' ? 'booked' : status === 'Pending' || status === 'Upcoming' ? 'notified' : null;
  if (!finality) return null;
  const at = Date.parse(tx.statusInfo.bookingDate ?? tx.createdAt);
  return {
    provider: 'swan',
    providerRef: `${tx.id}:${finality}`,
    tenantId: account.tenantId,
    receivingAccountId: account.id,
    receivingIban: tx.paymentMethodIdentifier ?? tx.creditor?.IBAN ?? null,
    amountCents,
    currency: 'EUR',
    remittance: tx.label ?? null,
    endToEndId: tx.reference ?? null,
    debtorName: tx.debtor?.name ?? tx.counterparty ?? null,
    debtorAccount: tx.debtor?.IBAN ?? null,
    scheme: tx.type === 'SepaInstantCreditTransferIn' ? 'sepa_inst' : 'sepa',
    finality,
    occurredAt: Number.isFinite(at) ? Math.floor(at / 1000) : Math.floor(Date.now() / 1000),
    raw: tx,
  };
}

export interface SwanWebhookDeps {
  accounts(): Promise<ReceivingAccount[]>;
  client(account: ReceivingAccount): SwanClient;
  insert(ev: CreditEvent): Promise<number | null>;
  match(ev: CreditEvent): Promise<MatchResult>;
  settle(ev: CreditEvent, sid: string): Promise<string | null>;
  recordMatch(id: number, args: { sid: string | null; by: string | null; note: string | null; settlementRef: string | null }): Promise<void>;
  alert(text: string): Promise<void>;
}

export function makeSwanWebhookDeps(env: Env, tenantId: string): SwanWebhookDeps {
  return {
    accounts: async () => {
      const rows = await listActiveReceivingAccounts(env, tenantId, 'swan');
      return Promise.all(rows.map((r) => decryptReceivingAccount(env, r)));
    },
    client: (a) =>
      makeSwanClient({ environment: a.environment, clientId: a.clientId ?? '', clientSecret: a.clientSecret ?? '' }),
    insert: (ev) => insertCreditEvent(env, ev),
    match: (ev) => matchCreditEvent(makeMatcherDeps(env, tenantId), ev),
    settle: (ev, sid) => settleFiatCredit(env, ev, sid),
    recordMatch: (id, args) => recordMatch(env, id, args),
    alert: (text) => sendAlert(env, text),
  };
}

export interface SwanWebhookResponse {
  status: 200 | 401 | 404 | 500;
  body: Record<string, unknown>;
}

export async function handleSwanWebhook(
  deps: SwanWebhookDeps,
  tenantId: string,
  rawBody: string,
  headers: Headers,
): Promise<SwanWebhookResponse> {
  const accounts = (await deps.accounts()).filter((a) => a.externalAccountId && a.clientId && a.clientSecret);
  if (accounts.length === 0) return { status: 404, body: { error: 'no_swan_account' } };

  // Shared secret, when the tenant configured one on any of its accounts.
  const secrets = accounts.map((a) => a.webhookSecret).filter((s): s is string => !!s);
  if (secrets.length > 0) {
    const got = headers.get('x-swan-secret') ?? '';
    if (!secrets.some((s) => timingSafeEqual(s, got))) return { status: 401, body: { error: 'invalid_secret' } };
  }

  let body: SwanWebhookBody;
  try {
    body = JSON.parse(rawBody) as SwanWebhookBody;
  } catch {
    return { status: 200, body: { ok: true, ignored: 'invalid_json' } };
  }
  if (!body.eventType?.startsWith('Transaction.') || !body.resourceId) {
    return { status: 200, body: { ok: true, ignored: body.eventType ?? 'no_event_type' } };
  }

  // Re-read with each account's credentials; only a transaction on that
  // account counts (one tenant URL never acts on another account's money).
  let tx: SwanTransaction | null = null;
  let account: ReceivingAccount | null = null;
  try {
    for (const a of accounts) {
      const t = await deps.client(a).getTransaction(body.resourceId);
      if (t?.account?.id && t.account.id === a.externalAccountId) {
        tx = t;
        account = a;
        break;
      }
    }
  } catch (e) {
    console.error(`swan webhook tenant=${tenantId} fetch ${body.resourceId} failed: ${(e as Error).message}`);
    return { status: 500, body: { error: 'fetch_failed' } };
  }
  if (!tx || !account) return { status: 200, body: { ok: true, ignored: 'not_this_tenant_account' } };

  const ev = normalizeSwanTransaction(tx, account);
  if (!ev) return { status: 200, body: { ok: true, ignored: `${tx.type}/${tx.statusInfo?.status}` } };

  const id = await deps.insert(ev);
  if (id === null) return { status: 200, body: { ok: true, dedup: true } };
  if (ev.finality !== 'booked') return { status: 200, body: { ok: true, finality: ev.finality } };

  try {
    const m = await deps.match(ev);
    if (m.kind === 'none') {
      await deps.recordMatch(id, { sid: null, by: null, note: m.note, settlementRef: null });
      await safely(deps.alert(
        `⚠️ <b>Swan uplata bez intenta</b>\n` +
          `tenant: <code>${tenantId}</code> · ${(ev.amountCents / 100).toFixed(2)} € · ${ev.debtorName ?? '-'}\n` +
          `opis: <code>${ev.remittance ?? '-'}</code>\n${m.note}`,
      ));
      return { status: 200, body: { ok: true, matched: false, note: m.note } };
    }
    const ref = await deps.settle(ev, m.sid);
    await deps.recordMatch(id, { sid: m.sid, by: m.by, note: m.note, settlementRef: ref });
    if (m.note?.startsWith('stray_ambiguous')) {
      await safely(deps.alert(`⚠️ <b>Swan uplata, više kandidata</b>\ntenant: <code>${tenantId}</code> → <code>${m.sid}</code>\n${m.note}`));
    }
    return { status: 200, body: { ok: true, matched: true, sid: m.sid, by: m.by } };
  } catch (e) {
    // The inbox row stays (insert-only); the match columns stay empty, which
    // is what an operator looks for. Swan's retry dedups on the inbox.
    console.error(`swan settle tenant=${tenantId} tx=${tx.id} failed: ${(e as Error).message}`);
    await safely(deps.alert(`🛑 <b>Swan namirenje palo</b>\ntenant: <code>${tenantId}</code> · tx <code>${tx.id}</code>\n${(e as Error).message}`));
    return { status: 200, body: { ok: false, error: 'settle_failed' } };
  }
}

async function safely(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (e) {
    console.error(`swan webhook side-effect failed: ${(e as Error).message}`);
  }
}
