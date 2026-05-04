import type { Env } from '../types';
import type {
  BankingProvider,
  Institution,
  ProviderAccount,
  ProviderTransaction,
  AuthorizationStart,
  AuthorizationFinalize,
} from './types';

const TOKEN_KEY = 'gocardless:access_token';

interface AccessTokenResponse {
  access: string;
  access_expires: number;
  refresh: string;
  refresh_expires: number;
}

interface GoCardlessTransaction {
  transactionId?: string;
  internalTransactionId?: string;
  bookingDate?: string;
  valueDate?: string;
  transactionAmount: { amount: string; currency: string };
  remittanceInformationUnstructured?: string;
  remittanceInformationUnstructuredArray?: string[];
  creditorName?: string;
  debtorName?: string;
  creditorAccount?: { iban?: string };
  debtorAccount?: { iban?: string };
}

export class GoCardlessProvider implements BankingProvider {
  readonly name = 'gocardless';

  constructor(private env: Env) {}

  private async fetchNewToken(): Promise<AccessTokenResponse> {
    const res = await fetch(`${this.env.GOCARDLESS_BASE_URL}/token/new/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        secret_id: this.env.GOCARDLESS_SECRET_ID,
        secret_key: this.env.GOCARDLESS_SECRET_KEY,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `GoCardless token error: ${res.status} ${await res.text()}`,
      );
    }
    return (await res.json()) as AccessTokenResponse;
  }

  private async getAccessToken(): Promise<string> {
    const cached = await this.env.TOKEN_CACHE.get(TOKEN_KEY);
    if (cached) return cached;
    const tok = await this.fetchNewToken();
    const ttl = Math.max(60, tok.access_expires - 300);
    await this.env.TOKEN_CACHE.put(TOKEN_KEY, tok.access, {
      expirationTtl: ttl,
    });
    return tok.access;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.env.GOCARDLESS_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(
        `GoCardless ${path} → ${res.status}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  async listInstitutions(country: string): Promise<Institution[]> {
    return this.call<Institution[]>(`/institutions/?country=${country}`);
  }

  async createAuthorization(args: {
    institutionId: string;
    reference: string;
    redirectUrl: string;
  }): Promise<AuthorizationStart> {
    const r = await this.call<{
      id: string;
      link: string;
      status: string;
    }>('/requisitions/', {
      method: 'POST',
      body: JSON.stringify({
        redirect: args.redirectUrl,
        institution_id: args.institutionId,
        reference: args.reference,
        user_language: 'HR',
      }),
    });
    return { id: r.id, link: r.link, status: r.status };
  }

  async finalizeAuthorization(args: {
    authorizationId: string;
  }): Promise<AuthorizationFinalize> {
    const detail = await this.call<{
      status: string;
      accounts: string[];
    }>(`/requisitions/${args.authorizationId}/`);
    const accounts: ProviderAccount[] = [];
    for (const accId of detail.accounts) {
      try {
        const d = await this.getAccountDetails(accId);
        accounts.push({ ...d, id: accId });
      } catch {
        accounts.push({ id: accId });
      }
    }
    return { status: detail.status, accounts };
  }

  async getAccountDetails(accountId: string): Promise<ProviderAccount> {
    const d = await this.call<{
      account: {
        iban?: string;
        currency?: string;
        name?: string;
        ownerName?: string;
      };
    }>(`/accounts/${accountId}/details/`);
    return {
      id: accountId,
      iban: d.account.iban,
      name: d.account.name ?? d.account.ownerName,
      currency: d.account.currency,
    };
  }

  async getAccountTransactions(accountId: string): Promise<{
    booked: ProviderTransaction[];
    pending: ProviderTransaction[];
  }> {
    const res = await this.call<{
      transactions: {
        booked: GoCardlessTransaction[];
        pending: GoCardlessTransaction[];
      };
    }>(`/accounts/${accountId}/transactions/`);
    return {
      booked: (res.transactions.booked ?? []).map(this.normalize),
      pending: (res.transactions.pending ?? []).map(this.normalize),
    };
  }

  private normalize = (t: GoCardlessTransaction): ProviderTransaction => {
    const id = t.transactionId ?? t.internalTransactionId ?? '';
    const amount = parseFloat(t.transactionAmount.amount);
    const incoming = amount >= 0;
    const remittance =
      t.remittanceInformationUnstructured ??
      t.remittanceInformationUnstructuredArray?.join(' ');
    return {
      id,
      bookingDate: t.bookingDate,
      valueDate: t.valueDate,
      amount,
      currency: t.transactionAmount.currency,
      remittanceInfo: remittance,
      counterpartyName: incoming ? t.debtorName : t.creditorName,
      counterpartyIban: incoming ? t.debtorAccount?.iban : t.creditorAccount?.iban,
      raw: t,
    };
  };
}
