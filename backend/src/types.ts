export interface Env {
  DB: D1Database;
  TOKEN_CACHE: KVNamespace;

  ADMIN_TOKEN: string;
  /// Basic Auth credentials gating the branded /admin HTML dashboard.
  /// If either is empty the /admin tree returns 503 so we never accidentally
  /// expose the webhook audit log unauthenticated.
  MONERIUM_ADMIN_USER: string;
  MONERIUM_ADMIN_PASS: string;
  ALLOWED_ORIGINS: string;
  BANKING_PROVIDER: string; // "enable_banking" | "gocardless"

  // Enable Banking
  ENABLE_BANKING_BASE_URL: string;
  ENABLE_BANKING_APPLICATION_ID: string;
  ENABLE_BANKING_PRIVATE_KEY: string; // PEM PKCS8
  ENABLE_BANKING_REDIRECT_URL: string;

  // GoCardless (kept for backward compatibility / fallback)
  GOCARDLESS_BASE_URL: string;
  GOCARDLESS_REDIRECT_URL: string;
  GOCARDLESS_SECRET_ID: string;
  GOCARDLESS_SECRET_KEY: string;

  // Monerium (Private app — fiat↔EURe bridge for ITalk's own account)
  MONERIUM_BASE_URL: string; // https://api.monerium.dev (sandbox) or https://api.monerium.app
  MONERIUM_CLIENT_ID: string;
  MONERIUM_CLIENT_SECRET: string;
  MONERIUM_WEBHOOK_SECRET: string; // HMAC secret configured in Monerium dashboard
  MONERIUM_PROFILE_ID: string; // optional; if empty client picks the first profile

  // MPT routing — Safe + Zodiac Roles forward path. EURe minted by Monerium
  // lands in SAFE_ADDRESS (Monerium default wallet), then this backend submits
  // `execTransactionWithRole(...)` against ROLES_MODIFIER_ADDRESS using
  // ROUTER_PRIVATE_KEY (an EOA registered as a member of ROLE_KEY, which is
  // scoped on-chain to only allow EURe.transfer). Empty = routing disabled.
  GNOSIS_RPC_URL: string;          // default https://rpc.gnosischain.com
  EURE_CONTRACT: string;           // 0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430
  SAFE_ADDRESS: string;            // MPT main-rail Safe (Monerium default wallet)
  ROLES_MODIFIER_ADDRESS: string;  // Zodiac Roles Modifier v2 instance bound to SAFE_ADDRESS
  ROLE_KEY: string;                // bytes32 hex (0x… 64 chars) — "EUReForwarder" role
  ROUTER_PRIVATE_KEY: string;      // EOA private key (secret); member of ROLE_KEY
}

export interface AccountRow {
  id: string;
  authorization_id: string;
  provider: string;
  iban: string | null;
  name: string | null;
  currency: string | null;
  last_refreshed_at: number | null;
}

export interface TxRow {
  id: string;
  account_id: string;
  booking_date: string | null;
  value_date: string | null;
  amount: number;
  currency: string | null;
  remittance_info: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  raw_json: string | null;
}
