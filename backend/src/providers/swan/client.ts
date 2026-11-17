/// Minimal Swan partner API client: OAuth2 client credentials + one GraphQL
/// query (`transaction(id)`). Probe 2026-11-17: docs/research/provideri/swan.md.

export const SWAN_OAUTH_URL = 'https://oauth.swan.io/oauth2/token';
export const SWAN_GRAPHQL_URL = {
  sandbox: 'https://api.swan.io/sandbox-partner/graphql',
  live: 'https://api.swan.io/live-partner/graphql',
} as const;
/// Testing API (simulators), sandbox only. Same client-credentials token as
/// the partner API; schema checked 2026-11-17 by introspection.
export const SWAN_TESTING_URL = 'https://api.swan.io/sandbox-partner-admin/graphql';

export interface SwanTransaction {
  __typename: string;
  id: string;
  type: string;
  side: 'Credit' | 'Debit';
  label: string | null;
  reference: string | null;
  paymentMethodIdentifier: string | null;
  counterparty: string | null;
  createdAt: string;
  amount: { value: string; currency: string };
  statusInfo: { status: string; bookingDate?: string | null };
  account?: { id: string } | null;
  creditor?: { name: string | null; IBAN: string | null } | null;
  debtor?: { name: string | null; IBAN: string | null } | null;
}

export const TRANSACTION_QUERY = `query MptCreditTx($id: ID!) {
  transaction(id: $id) {
    __typename id type side label reference paymentMethodIdentifier counterparty createdAt
    amount { value currency }
    statusInfo { status ... on BookedTransactionStatusInfo { bookingDate } }
    ... on SEPACreditTransferTransaction {
      account { id }
      creditor { name IBAN }
      debtor { name IBAN }
    }
  }
}`;

export const ACCOUNT_IBANS_QUERY = `query MptAccountIbans($id: ID!) {
  account(accountId: $id) {
    IBAN name
    holder { info { name } }
    virtualIbanEntries(first: 10) { edges { node { IBAN status } } }
  }
}`;

export interface SwanAccountIbans {
  /// The account's own IBAN; null until the account is opened.
  iban: string | null;
  /// Enabled virtual IBANs, in Swan's order.
  virtualIbans: string[];
  holderName: string | null;
}

export const SIMULATE_SEPA_IN_MUTATION = `mutation MptSimulateSepaIn($input: IncomingSepaCreditTransferInput!) {
  simulateIncomingSepaCreditTransferReception(input: $input) {
    __typename
    ... on SimulateIncomingSepaCreditTransferReceptionSuccessPayload { transactionId }
    ... on Rejection { message }
  }
}`;

export interface SimulateSepaInInput {
  amount: { value: string; currency: 'EUR' };
  creditorIban: string;
  creditorName: string;
  debtorIban: string;
  debtorName: string;
  label?: string;
  endToEndId?: string;
  isInstant?: boolean;
}

export interface SwanClient {
  getTransaction(id: string): Promise<SwanTransaction | null>;
  getAccountIbans(accountId: string): Promise<SwanAccountIbans | null>;
  /// Testing API; throws on a rejection. Returns the new transaction id.
  simulateIncomingSepa(input: SimulateSepaInInput): Promise<string>;
}

export function makeSwanClient(args: {
  environment: 'sandbox' | 'live';
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): SwanClient {
  const f = args.fetchImpl ?? fetch;
  let token: { value: string; exp: number } | null = null;

  async function accessToken(): Promise<string> {
    const now = Date.now();
    if (token && token.exp > now + 30_000) return token.value;
    const res = await f(SWAN_OAUTH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: args.clientId,
        client_secret: args.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new Error(`swan oauth ${res.status}`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error('swan oauth: no access_token');
    token = { value: j.access_token, exp: now + (j.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function gql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T | undefined> {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessToken()}` },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`swan graphql ${res.status}`);
    const j = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (j.errors?.length) throw new Error(`swan graphql: ${j.errors[0].message}`);
    return j.data;
  }

  return {
    async getTransaction(id) {
      const d = await gql<{ transaction?: SwanTransaction | null }>(
        SWAN_GRAPHQL_URL[args.environment], TRANSACTION_QUERY, { id });
      return d?.transaction ?? null;
    },
    async getAccountIbans(accountId) {
      type Acc = {
        IBAN: string | null;
        name: string | null;
        holder?: { info?: { name?: string | null } | null } | null;
        virtualIbanEntries?: { edges?: Array<{ node?: { IBAN?: string | null; status?: string | null } | null }> } | null;
      };
      const d = await gql<{ account?: Acc | null }>(
        SWAN_GRAPHQL_URL[args.environment], ACCOUNT_IBANS_QUERY, { id: accountId });
      const a = d?.account;
      if (!a) return null;
      return {
        iban: a.IBAN ?? null,
        virtualIbans: (a.virtualIbanEntries?.edges ?? [])
          .map((e) => e.node)
          .filter((n) => !!n?.IBAN && n.status === 'Enabled')
          .map((n) => n!.IBAN!),
        holderName: a.holder?.info?.name ?? a.name ?? null,
      };
    },
    async simulateIncomingSepa(input) {
      if (args.environment !== 'sandbox') throw new Error('swan testing api: sandbox only');
      const d = await gql<{
        simulateIncomingSepaCreditTransferReception?: { __typename: string; transactionId?: string; message?: string };
      }>(SWAN_TESTING_URL, SIMULATE_SEPA_IN_MUTATION, { input });
      const p = d?.simulateIncomingSepaCreditTransferReception;
      if (!p?.transactionId) throw new Error(`swan simulate: ${p?.__typename ?? 'no payload'}${p?.message ? ` ${p.message}` : ''}`);
      return p.transactionId;
    },
  };
}
