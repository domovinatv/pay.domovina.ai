/// Minimal Swan partner API client: OAuth2 client credentials + one GraphQL
/// query (`transaction(id)`). Probe 2026-11-17: docs/research/provideri/swan.md.

export const SWAN_OAUTH_URL = 'https://oauth.swan.io/oauth2/token';
export const SWAN_GRAPHQL_URL = {
  sandbox: 'https://api.swan.io/sandbox-partner/graphql',
  live: 'https://api.swan.io/live-partner/graphql',
} as const;

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

export interface SwanClient {
  getTransaction(id: string): Promise<SwanTransaction | null>;
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

  return {
    async getTransaction(id) {
      const res = await f(SWAN_GRAPHQL_URL[args.environment], {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessToken()}` },
        body: JSON.stringify({ query: TRANSACTION_QUERY, variables: { id } }),
      });
      if (!res.ok) throw new Error(`swan graphql ${res.status}`);
      const j = (await res.json()) as { data?: { transaction?: SwanTransaction | null }; errors?: Array<{ message: string }> };
      if (j.errors?.length) throw new Error(`swan graphql: ${j.errors[0].message}`);
      return j.data?.transaction ?? null;
    },
  };
}
