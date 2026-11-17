-- ADR 0032 — više izvora priljeva: inbox normaliziranih događaja priljeva i
-- računi primatelja po tenantu (prvi korisnik: Swan, fiat_notify).
--
-- Monerium put se ovom migracijom NE mijenja; njegov upis u inbox je sljedeći
-- korak (ADR 0032, redoslijed 1).

-- Tenantov račun kod providera. Jedan tenant može imati više računa.
CREATE TABLE receiving_accounts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id            TEXT    NOT NULL REFERENCES tenants(id),
  provider             TEXT    NOT NULL,            -- 'swan' | 'wise' | 'lhv' | 'bank_push' | …
  mode                 TEXT    NOT NULL CHECK (mode IN ('onchain_mint', 'fiat_notify')),
  iban                 TEXT,                         -- glavni IBAN računa (informativno)
  environment          TEXT    NOT NULL DEFAULT 'live' CHECK (environment IN ('sandbox', 'live')),
  external_account_id  TEXT,                         -- id računa kod providera (Swan accountId)
  client_id            TEXT,                         -- javni dio pristupnih podataka
  client_secret_enc    TEXT,                         -- encryptSecret(field 'client_secret')
  webhook_secret_enc   TEXT,                         -- encryptSecret(field 'webhook_secret'), opcionalno
  label                TEXT,
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL,
  UNIQUE (provider, external_account_id)
);
CREATE INDEX idx_receiving_accounts_tenant ON receiving_accounts (tenant_id, provider, active);

-- Inbox: insert-only, jedan red po (provider, provider_ref). Ponovljena
-- isporuka istog događaja ne može se upariti dvaput.
CREATE TABLE credit_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  provider              TEXT    NOT NULL,
  provider_ref          TEXT    NOT NULL,
  tenant_id             TEXT    NOT NULL,
  receiving_account_id  INTEGER REFERENCES receiving_accounts(id),
  receiving_iban        TEXT,
  amount_cents          INTEGER NOT NULL,
  currency              TEXT    NOT NULL,
  remittance            TEXT,
  end_to_end_id         TEXT,
  debtor_name           TEXT,
  debtor_account        TEXT,
  scheme                TEXT,                        -- 'sepa' | 'sepa_inst'
  finality              TEXT    NOT NULL CHECK (finality IN ('notified', 'booked', 'onchain_confirmed')),
  occurred_at           INTEGER NOT NULL,
  raw                   TEXT,
  -- Ishod uparivanja (postavlja se jednom, nakon inserta).
  matched_sid           TEXT,
  matched_by            TEXT,                        -- 'sid' | 'short_ref' | 'stray' | NULL
  match_note            TEXT,
  settlement_ref        TEXT,                        -- npr. sintetski order id kojim je intent namiren
  created_at            INTEGER NOT NULL,
  UNIQUE (provider, provider_ref)
);
CREATE INDEX idx_credit_events_tenant ON credit_events (tenant_id, created_at);
