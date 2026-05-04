import type { Env } from '../types';

export interface Institution {
  id: string;
  name: string;
  bic?: string;
  countries: string[];
  logo?: string;
}

export interface ProviderAccount {
  id: string;
  iban?: string;
  name?: string;
  currency?: string;
}

/// Normalized transaction shape. Amount is a signed number in account currency:
/// positive = incoming credit, negative = outgoing debit.
export interface ProviderTransaction {
  id: string;
  bookingDate?: string;
  valueDate?: string;
  amount: number;
  currency: string;
  remittanceInfo?: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  raw: unknown;
}

export interface AuthorizationStart {
  /// Provider-specific id used to look the authorization up later.
  /// For GoCardless: requisition_id. For Enable Banking: auth_id.
  id: string;
  /// SCA URL that the user opens in a browser.
  link: string;
  status: string;
}

export interface AuthorizationFinalize {
  status: string;
  /// May be empty when the SCA flow was abandoned. Provider-specific account ids.
  accounts: ProviderAccount[];
  /// Enable Banking returns a session_id that's needed for follow-up calls.
  /// GoCardless does not — it uses the account id directly.
  sessionId?: string;
}

export interface BankingProvider {
  readonly name: string;
  listInstitutions(country: string): Promise<Institution[]>;
  createAuthorization(args: {
    institutionId: string;
    reference: string;
    redirectUrl: string;
  }): Promise<AuthorizationStart>;
  /// `code` is provided by Enable Banking via the SCA redirect; ignored by GoCardless.
  finalizeAuthorization(args: {
    authorizationId: string;
    code?: string;
  }): Promise<AuthorizationFinalize>;
  getAccountDetails(accountId: string): Promise<ProviderAccount>;
  getAccountTransactions(accountId: string): Promise<{
    booked: ProviderTransaction[];
    pending: ProviderTransaction[];
  }>;
}

export type ProviderName = 'enable_banking' | 'gocardless';

export function pickProvider(env: Env): ProviderName {
  const v = (env.BANKING_PROVIDER ?? 'enable_banking').toLowerCase();
  if (v === 'gocardless' || v === 'enable_banking') return v;
  throw new Error(`Unknown BANKING_PROVIDER: ${env.BANKING_PROVIDER}`);
}
