export interface Env {
  DB: D1Database;
  /// Public app URL (no trailing slash), e.g. https://mpt-shopify.domovina.ai
  APP_URL: string;
  /// MPT backend origin, e.g. https://mpt.domovina.ai
  MPT_API_BASE: string;
  /// Shared (unlisted public) app's client id. Optional: custom-distribution
  /// apps, one per merchant, are registered in D1 via /admin/apps.
  SHOPIFY_API_KEY?: string;
  SHOPIFY_SCOPES: string; // "read_orders,write_orders"
  SHOPIFY_API_VERSION: string; // "2026-07"
  // Secrets (wrangler secret put):
  SHOPIFY_API_SECRET?: string; // shared app's client secret (only with SHOPIFY_API_KEY)
  TOKEN_KEK: string; // base64 of 32 bytes, AES-GCM for D1 secrets
  SID_SECRET: string; // HMAC key for deriveSid
  ADMIN_TOKEN: string; // operator bearer for /admin/*
}

export interface ShopRow {
  shop: string;
  client_id: string | null;
  access_token_enc: string | null;
  access_expires_at: number | null;
  refresh_token_enc: string | null;
  refresh_expires_at: number | null;
  scope: string | null;
  installed_at: number;
  uninstalled_at: number | null;
  active: number;
  mpt_api_key_enc: string | null;
  mpt_webhook_secret_enc: string | null;
  target_address: string | null;
  gateway_match: string;
  intent_ttl_seconds: number;
  auto_cancel: number;
  updated_at: number;
}

export type OrderStatus =
  | 'pending' // QR issued, nothing seen yet
  | 'received' // Monerium holds the SEPA funds (payment.received)
  | 'paid' // settled on-chain, order marked paid in Shopify
  | 'underpaid' // settled for less than the order total — needs a human
  | 'rejected' // Monerium refused; funds returned to payer
  | 'expired' // intent expired unpaid
  | 'cancelled'; // we cancelled the Shopify order (auto_cancel)

export interface OrderRow {
  sid: string;
  shop: string;
  order_gid: string;
  order_name: string | null;
  amount_cents: number;
  status: OrderStatus;
  intent_json: string | null;
  expires_at: number | null;
  paid_at: number | null;
  forward_tx_hash: string | null;
  amount_received_cents: number | null;
  shopify_synced_at: number | null;
  last_error: string | null;
  last_polled_at: number | null;
  created_at: number;
  updated_at: number;
}

/// Subset of the MPT intent representation (backend/src/intents/api.ts
/// intentResponseJson + status) this app relies on.
export interface MptIntent {
  sid: string;
  state: 'pending' | 'paid' | 'expired';
  amount_eur: string;
  amount_cents: number;
  memo: string;
  iban: string;
  beneficiary_name: string;
  bic: string | null;
  epc_qr_data: string;
  checkout_url: string;
  expires_at: string;
  paid_at: string | null;
  forward_tx_hash: string | null;
  amount_received_cents: number | null;
  /// Set once the rail settled a payment for this intent — including an
  /// underpayment, which (BW-01) leaves paid_at null and the state pending.
  monerium_order_id?: string | null;
  status?: { stage: string; review_expected?: boolean | null; amount_mismatch?: 'under' | 'over' | null };
}
