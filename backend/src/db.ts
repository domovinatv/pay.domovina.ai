import type { Env, AccountRow, TxRow } from './types';
import type { ProviderTransaction, ProviderAccount } from './providers/types';

export async function insertAuthorization(
  env: Env,
  args: {
    id: string;
    provider: string;
    institutionId: string;
    reference: string;
    status: string;
    link: string;
    sessionId?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO authorizations
       (id, provider, institution_id, reference, status, link, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.id,
      args.provider,
      args.institutionId,
      args.reference,
      args.status,
      args.link,
      args.sessionId ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

export async function updateAuthorizationSession(
  env: Env,
  authorizationId: string,
  sessionId: string,
  status: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE authorizations SET session_id = ?, status = ? WHERE id = ?`,
  )
    .bind(sessionId, status, authorizationId)
    .run();
}

export async function listAuthorizations(env: Env): Promise<
  {
    id: string;
    provider: string;
    institution_id: string;
    status: string | null;
    created_at: number;
  }[]
> {
  const res = await env.DB.prepare(
    `SELECT id, provider, institution_id, status, created_at
     FROM authorizations ORDER BY created_at DESC`,
  ).all<{
    id: string;
    provider: string;
    institution_id: string;
    status: string | null;
    created_at: number;
  }>();
  return res.results;
}

export async function upsertAccount(
  env: Env,
  args: {
    id: string;
    authorizationId: string;
    provider: string;
    account: ProviderAccount;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO accounts
       (id, authorization_id, provider, iban, name, currency, last_refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       iban = excluded.iban,
       name = excluded.name,
       currency = excluded.currency,
       last_refreshed_at = excluded.last_refreshed_at`,
  )
    .bind(
      args.id,
      args.authorizationId,
      args.provider,
      args.account.iban ?? null,
      args.account.name ?? null,
      args.account.currency ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

export async function listAccounts(env: Env): Promise<AccountRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, authorization_id, provider, iban, name, currency, last_refreshed_at
     FROM accounts ORDER BY id`,
  ).all<AccountRow>();
  return res.results;
}

export async function getAccount(
  env: Env,
  accountId: string,
): Promise<AccountRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, authorization_id, provider, iban, name, currency, last_refreshed_at
     FROM accounts WHERE id = ?`,
  )
    .bind(accountId)
    .first<AccountRow>();
  return row ?? null;
}

export async function listTransactions(
  env: Env,
  accountId: string,
  limit = 200,
): Promise<TxRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, account_id, booking_date, value_date, amount, currency,
            remittance_info, counterparty_name, counterparty_iban, raw_json
     FROM transactions
     WHERE account_id = ?
     ORDER BY booking_date DESC, id DESC
     LIMIT ?`,
  )
    .bind(accountId, limit)
    .all<TxRow>();
  return res.results;
}

export async function upsertTransactions(
  env: Env,
  accountId: string,
  txs: ProviderTransaction[],
): Promise<number> {
  const stmt = env.DB.prepare(
    `INSERT INTO transactions
       (id, account_id, booking_date, value_date, amount, currency,
        remittance_info, counterparty_name, counterparty_iban, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const batch: D1PreparedStatement[] = [];
  for (const t of txs) {
    if (!t.id) continue;
    batch.push(
      stmt.bind(
        t.id,
        accountId,
        t.bookingDate ?? null,
        t.valueDate ?? null,
        t.amount,
        t.currency ?? null,
        t.remittanceInfo ?? null,
        t.counterpartyName ?? null,
        t.counterpartyIban ?? null,
        JSON.stringify(t.raw),
      ),
    );
  }
  if (batch.length === 0) return 0;
  await env.DB.batch(batch);
  return batch.length;
}
