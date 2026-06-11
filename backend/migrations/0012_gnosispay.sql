-- Gnosis Pay kartice (docs/plans/gnosis-pay-cards/04-backend-webhooks-iban.md).
-- Backend je tanak: FE zove api.gnosispay.com direktno (user-scoped SIWE JWT);
-- ovdje samo mirror onboarding stanja (support/analytics) + webhook event log.
-- Bez PAN-a, imena, adresa, KYC podataka — samo statusi.

CREATE TABLE gp_users (
  credential_id   TEXT NOT NULL,            -- naš identitet (→ wallet_registry.credential_id)
  safe_address    TEXT NOT NULL,            -- DOMOVINA Safe vezan uz GP account
  gp_user_id      TEXT,                     -- GP userId (iz JWT-a)
  gp_signer       TEXT NOT NULL,            -- adresa koja je GP SIWE identitet (NEPOVRATNO)
  gp_safe_address TEXT,                     -- GP Safe (refresh kroz /safe/migration!)
  onboarding_step TEXT NOT NULL,            -- mirror state machinea (GpStep)
  kyc_status      TEXT,
  webhook_opt_in  INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (credential_id, safe_address)
);

CREATE INDEX idx_gp_users_gp_user ON gp_users (gp_user_id) WHERE gp_user_id IS NOT NULL;

-- Webhook log + dedupe + Activity keš (receiver dolazi u Fazi 3; shema odmah
-- da FE sync i webhook dijele istu migraciju).
CREATE TABLE gp_events (
  id          TEXT PRIMARY KEY,             -- threadId:eventType:clearedAt|status
  gp_user_id  TEXT,
  event_type  TEXT NOT NULL,
  thread_id   TEXT,
  raw_json    TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_gp_events_user ON gp_events (gp_user_id, received_at DESC);
