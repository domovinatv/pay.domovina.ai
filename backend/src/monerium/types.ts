/// Shape of a Monerium order as returned by the v2 API and webhook events.
/// Ref: https://monerium.dev/api-docs/v2 — kept loose because Monerium has
/// added optional fields over time and we don't want to break on new ones.
export interface MoneriumOrder {
  id: string;
  profile?: string;
  accountId?: string;
  kind: 'issue' | 'redeem';
  amount: string;
  currency: string; // 'eur' | 'gbp' | 'usd' (lowercase per Monerium convention)
  address?: string;
  chain?: string;
  /// Live state on the order. Monerium puts this at the top level (v2 API),
  /// not inside `meta`.
  state?: 'placed' | 'pending' | 'processed' | 'rejected';
  counterpart?: {
    identifier?:
      | { standard: 'iban'; iban: string; bic?: string }
      | { standard: 'chain'; address: string; chain: string };
    details?: {
      name?: string;
      country?: string;
      [k: string]: unknown;
    };
  };
  memo?: string;
  referenceNumber?: string;
  meta?: {
    placedAt?: string;
    processedAt?: string;
    placedBy?: string;
    receivedAmount?: string;
    sentAmount?: string;
    txHashes?: string[];
    /// Older payloads kept state in meta — accept it as a fallback.
    state?: 'placed' | 'pending' | 'processed' | 'rejected';
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface MoneriumWebhookEvent {
  /// Monerium uses different naming across versions; we accept either.
  type?: string;
  event?: string;
  data?: MoneriumOrder;
  order?: MoneriumOrder;
  [k: string]: unknown;
}

export interface MoneriumProfile {
  id: string;
  name?: string;
  kind?: string;
}

export interface MoneriumTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  profile?: string;
  userId?: string;
}
