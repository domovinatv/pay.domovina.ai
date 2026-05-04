export interface Env {
  DB: D1Database;
  TOKEN_CACHE: KVNamespace;

  ADMIN_TOKEN: string;
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
