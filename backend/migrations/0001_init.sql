CREATE TABLE authorizations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  reference TEXT,
  status TEXT,
  link TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL REFERENCES authorizations(id),
  provider TEXT NOT NULL,
  iban TEXT,
  name TEXT,
  currency TEXT,
  last_refreshed_at INTEGER
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  booking_date TEXT,
  value_date TEXT,
  amount REAL NOT NULL,
  currency TEXT,
  remittance_info TEXT,
  counterparty_name TEXT,
  counterparty_iban TEXT,
  raw_json TEXT
);

CREATE INDEX idx_tx_account_date
  ON transactions(account_id, booking_date DESC);
