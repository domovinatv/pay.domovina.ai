-- Admin prijava (preneseno 1:1 iz bank-push-gateway worker/migrations/0002_admin.sql):
-- Cloudflare Access (OTP na e-mail) ili passkey, oba vode u istu sesiju. Zamjenjuje Basic Auth.


CREATE TABLE admin_passkeys (
  id            TEXT PRIMARY KEY,         -- credential ID, base64url
  email         TEXT NOT NULL,
  public_key    TEXT NOT NULL,            -- COSE, base64url; privatni ključ nikad ne napušta uređaj
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  label         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX admin_passkeys_email ON admin_passkeys (email);

-- U bazi samo sha-256 tokena iz kolačića: tko dobije bazu, ne dobije sesiju.
CREATE TABLE admin_sessions (
  token_hash    TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  method        TEXT NOT NULL,            -- 'passkey' | 'access'
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  user_agent    TEXT
);

-- WebAuthn izazovi: jednokratni, 5 min.
CREATE TABLE admin_challenges (
  challenge     TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL,            -- 'login' | 'register'
  email         TEXT,                     -- kod registracije: čiji se ključ upisuje
  expires_at    TEXT NOT NULL
);
