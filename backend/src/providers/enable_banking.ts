import { SignJWT, importPKCS8 } from 'jose';

import type { Env } from '../types';
import type {
  BankingProvider,
  Institution,
  ProviderAccount,
  ProviderTransaction,
  AuthorizationStart,
  AuthorizationFinalize,
} from './types';

interface EBAspsp {
  name: string;
  country: string;
  bic?: string;
  logo?: string;
}

interface EBAccount {
  uid: string;
  identification?: string;
  account_id?: { iban?: string };
  name?: string;
  details?: string;
  product?: string;
  currency?: string;
}

interface EBTransaction {
  entry_reference?: string;
  transaction_id?: string;
  booking_date?: string;
  value_date?: string;
  transaction_amount: { amount: string; currency: string };
  credit_debit_indicator?: 'CRDT' | 'DBIT';
  remittance_information?: string[];
  creditor?: { name?: string };
  debtor?: { name?: string };
  creditor_account?: { iban?: string };
  debtor_account?: { iban?: string };
}

const TOKEN_KEY = 'enable_banking:jwt';
const SESSION_PREFIX = 'enable_banking:session:';

/// Issues a JWT bearer signed with the application's private RSA key.
/// Enable Banking exchanges this JWT for an access token via the
/// `Authorization: Bearer <jwt>` header on every request — there is no
/// separate token endpoint.
async function makeJwt(env: Env): Promise<string> {
  const cached = await env.TOKEN_CACHE.get(TOKEN_KEY);
  if (cached) return cached;
  const pkcs8 = env.ENABLE_BANKING_PRIVATE_KEY;
  if (!pkcs8 || !env.ENABLE_BANKING_APPLICATION_ID) {
    throw new Error(
      'Enable Banking secrets missing: set ENABLE_BANKING_APPLICATION_ID and ENABLE_BANKING_PRIVATE_KEY',
    );
  }
  const key = await importPKCS8(pkcs8, 'RS256');
  const ttlSeconds = 3600;
  const jwt = await new SignJWT({})
    .setProtectedHeader({
      alg: 'RS256',
      typ: 'JWT',
      kid: env.ENABLE_BANKING_APPLICATION_ID,
    })
    .setIssuer('enablebanking.com')
    .setAudience('api.enablebanking.com')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
  // Cache for slightly less than the JWT lifetime
  await env.TOKEN_CACHE.put(TOKEN_KEY, jwt, {
    expirationTtl: ttlSeconds - 60,
  });
  return jwt;
}

export class EnableBankingProvider implements BankingProvider {
  readonly name = 'enable_banking';

  constructor(private env: Env) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const jwt = await makeJwt(this.env);
    const res = await fetch(`${this.env.ENABLE_BANKING_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(
        `EnableBanking ${path} → ${res.status}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  async listInstitutions(country: string): Promise<Institution[]> {
    const res = await this.call<{ aspsps: EBAspsp[] }>(
      `/aspsps?country=${country}`,
    );
    return res.aspsps.map((a) => ({
      id: `${a.name}|${a.country}`,
      name: a.name,
      bic: a.bic,
      countries: [a.country],
      logo: a.logo,
    }));
  }

  async createAuthorization(args: {
    institutionId: string;
    reference: string;
    redirectUrl: string;
  }): Promise<AuthorizationStart> {
    // Composite id is `<aspsp_name>|<country>`
    const [name, country] = args.institutionId.split('|');
    if (!name || !country) {
      throw new Error(
        `Invalid Enable Banking institutionId, expected "<name>|<country>"`,
      );
    }
    const validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
      .toISOString();
    const r = await this.call<{
      url: string;
      authorization_id: string;
      psu_id_hash?: string;
    }>('/auth', {
      method: 'POST',
      body: JSON.stringify({
        access: { valid_until: validUntil },
        aspsp: { name, country },
        state: args.reference,
        redirect_url: args.redirectUrl,
        psu_type: 'personal',
      }),
    });
    return {
      id: r.authorization_id,
      link: r.url,
      status: 'PENDING',
    };
  }

  async finalizeAuthorization(args: {
    authorizationId: string;
    code?: string;
  }): Promise<AuthorizationFinalize> {
    if (!args.code) {
      throw new Error(
        'Enable Banking finalize requires `code` from SCA redirect',
      );
    }
    const session = await this.call<{
      session_id: string;
      accounts: EBAccount[];
      status: string;
    }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ code: args.code }),
    });
    // Persist session_id keyed by each account uid so follow-up
    // /accounts/{uid}/transactions calls know which session to attach.
    for (const a of session.accounts) {
      await this.env.TOKEN_CACHE.put(
        SESSION_PREFIX + a.uid,
        session.session_id,
        // Sessions normally last up to 90 days; cap at 89 to be safe.
        { expirationTtl: 89 * 24 * 60 * 60 },
      );
    }
    return {
      status: session.status,
      sessionId: session.session_id,
      accounts: session.accounts.map((a) => ({
        id: a.uid,
        iban: a.account_id?.iban ?? a.identification,
        name: a.name ?? a.product,
        currency: a.currency,
      })),
    };
  }

  async getAccountDetails(accountId: string): Promise<ProviderAccount> {
    const d = await this.call<{ account: EBAccount }>(
      `/accounts/${accountId}/details`,
    );
    return {
      id: accountId,
      iban: d.account.account_id?.iban ?? d.account.identification,
      name: d.account.name ?? d.account.product,
      currency: d.account.currency,
    };
  }

  async getAccountTransactions(accountId: string): Promise<{
    booked: ProviderTransaction[];
    pending: ProviderTransaction[];
  }> {
    const dateFrom = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const [booked, pending] = await Promise.all([
      this.call<{ transactions: EBTransaction[] }>(
        `/accounts/${accountId}/transactions?date_from=${dateFrom}&transaction_status=BOOK`,
      ),
      this.call<{ transactions: EBTransaction[] }>(
        `/accounts/${accountId}/transactions?date_from=${dateFrom}&transaction_status=PDNG`,
      ).catch(() => ({ transactions: [] as EBTransaction[] })),
    ]);
    return {
      booked: booked.transactions.map(this.normalize),
      pending: pending.transactions.map(this.normalize),
    };
  }

  private normalize = (t: EBTransaction): ProviderTransaction => {
    const raw = parseFloat(t.transaction_amount.amount);
    const signed = t.credit_debit_indicator === 'DBIT' ? -Math.abs(raw) : raw;
    const incoming = signed >= 0;
    const id = t.transaction_id ?? t.entry_reference ?? '';
    const remittance = t.remittance_information?.join(' ');
    return {
      id,
      bookingDate: t.booking_date,
      valueDate: t.value_date,
      amount: signed,
      currency: t.transaction_amount.currency,
      remittanceInfo: remittance,
      counterpartyName: incoming ? t.debtor?.name : t.creditor?.name,
      counterpartyIban: incoming
        ? t.debtor_account?.iban
        : t.creditor_account?.iban,
      raw: t,
    };
  };
}
