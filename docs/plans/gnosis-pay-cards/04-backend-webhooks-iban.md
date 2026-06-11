# 04 — Backend: webhooks, baza, rekoncilijacija, Monerium kolizija

## Načelo: backend je tanak

GP API je user-JWT (SIWE) scoped i CORS-friendly — **frontend zove api.gnosispay.com direktno**.
Server ne može mintati user JWT-ove, pa "server u ime korisnika" ne postoji by design. Backend
treba samo za: (1) webhook receiver, (2) PSE mTLS token-proxy, (3) keš/state sync, (4) postojeći
relay za funding transfer (već postoji).

## Webhook receiver

Zahtijeva **Partnership tier** (besplatan, self-service) + per-user opt-in:

```mermaid
sequenceDiagram
    participant W as wallet (FE)
    participant GP as api.gnosispay.com
    participant WH as webhooks.gnosispay.com
    participant BE as backend /api/card/webhook
    participant D1 as D1 (card_events)
    participant DO as SSE Durable Object

    Note over W,GP: opt-in (jednom po korisniku)
    W->>GP: GET /api/v1/webhooks/message/{partnerId}
    GP-->>W: {message, nonce} (SIWE poruka)
    W->>W: korisnik potpiše (sign-in wallet)
    W->>GP: POST /api/v1/webhooks/subscribe/{partnerId} {message, signature}

    Note over WH,BE: delivery (svaki event)
    WH->>BE: POST {eventType, data}<br/>X-Webhook-Timestamp, X-Webhook-Signature (Ed25519)
    BE->>BE: verify Ed25519("timestamp.rawBody")<br/>public key kešran s GET webhooks.gnosispay.com/api/v1/public-key
    BE->>D1: upsert (idempotentno: threadId+eventType)
    BE->>DO: push → SSE → instant notifikacija u walletu
    BE-->>WH: 200 (< 30 s!)
```

- **Potpis: Ed25519** (asimetrični, ne HMAC) — `${timestamp}.${rawBody}`; verifikacija raw
  bodyja PRIJE parsanja; WebCrypto `crypto.subtle.verify("Ed25519", …)` radi na Workersima
  (format public keya iz endpointa neprovjeren — PEM ili raw; spike).
- **Retry: samo 3× (1/5/15 min)** → nakon ~21 min outagea eventi su izgubljeni → rekoncilijacija
  obavezna (dolje).
- Sami nametnuti timestamp freshness (±5 min) — docs ne mandatiraju replay zaštitu.
- Payloadi nose **kompletne entitete** (jer user JWT istječe) — obično nema follow-up API poziva.
- Idempotencija: postojeći obrazac iz Monerium webhooka (existing-forward check).

### Event katalog (bitniji)
- `card.transaction.created` (autorizacija — **trigger za instant push "−12,50 € Konzum"**),
  `…cleared`, `…declined`, `…reversed`, `…refunded`, `…confirmed`/`…failed` (onchain leg)
- `card.status.changed`, `virtual.card.issued`
- `kyc.status.changed`, `kyc.phone-validation.changed`, `kyc.source-of-funds.changed`,
  `user.created`, `user.tos.accepted` (server-side onboarding tracking bez pollanja!)
- `account.balance.changed {total, spendable, pending}`, `account.limit.changed`,
  `account.withdrawal.completed/failed`
- `safe.created`, `safe.modules.deployed`, `safe.owner.added/removed`
- `iban.created`, `iban.status.changed` (`NOTSTARTED|PENDING|PENDING_OAUTH|ASSIGNED`)

## Transakcije — API + prikaz

- `GET /api/v1/cards/transactions` — paginirano (`limit≥10`, `offset`, `next`/`previous`),
  filtri: `cardTokens`, `before/after`, `mcc`, `transactionType`, valute.
- Event = `threadId` (ključ za dedupe i dispute; auth+clearing+reversal dijele thread),
  `isPending`, `billingAmount` (**minor units string**, npr. `'2550'` + `decimals: 2` = 25,50 €),
  `merchant {name, city, country}`, `mcc`, `transactions[]` s onchain `hash` →
  link na Gnosisscan u Activity UI.
- Kind: `Payment` (odmah, status enum: `Approved | InsufficientFunds | IncorrectPin |
  ExceedsApprovalAmountLimit | …`), `Refund` (tek nakon clearinga), `Reversal`.
- **Dispute**: `GET /api/v1/transactions/dispute` (razlozi) →
  `POST /api/v1/transactions/{threadId}/dispute`; ⚠️ razlog
  `unrecognized_transaction_report_fraudulent` **odmah restrikta karticu** — warning u UI.
  Nema endpointa za status disputea (ide kroz GP support).

## D1 shema (nove tablice u backend/migrations)

```sql
-- 0012_gnosispay.sql
CREATE TABLE gp_users (
  credential_id   TEXT NOT NULL,            -- naš identitet (FK wallet_registry)
  safe_address    TEXT NOT NULL,            -- DOMOVINA Safe vezan uz GP account
  gp_user_id      TEXT,                     -- GP userId (iz JWT-a)
  gp_signer       TEXT NOT NULL,            -- adresa koja je GP SIWE identitet (NEPOVRATNO)
  gp_safe_address TEXT,                     -- GP Safe (refresh kroz /safe/migration!)
  onboarding_step TEXT NOT NULL,            -- mirror state machinea (analytics/support)
  kyc_status      TEXT,
  webhook_opt_in  INTEGER DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (credential_id, safe_address)
);

CREATE TABLE gp_events (                    -- webhook log + dedupe + Activity keš
  id          TEXT PRIMARY KEY,             -- threadId:eventType:clearedAt|status
  gp_user_id  TEXT,
  event_type  TEXT NOT NULL,
  thread_id   TEXT,
  raw_json    TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_gp_events_user ON gp_events (gp_user_id, received_at DESC);
```

Bez pohrane PAN-a, imena, adresa, KYC podataka — samo statusi i event log. Kartice (`cardId`,
`lastFourDigits`) čita FE direktno od GP-a.

## Rekoncilijacija

Webhooci su lossy (3 retryja); server ne može pollat u ime korisnika (nema JWT). Strategija:
1. **Webhook = primarni kanal** (full entiteti).
2. **Client-triggered sync**: svaki put kad korisnik otvori tab Kartica s validnim JWT-om, FE
   povuče `/cards/transactions` + `/account-balances` i POST-a diff našem backendu (keš za
   support/analytics; FE je ionako izvor prikaza).
3. **Onchain backstop**: mi već indexiramo EURe transfere — GP Safe adrese su nam poznate →
   neovisno vidimo punjenja i settlement transfere na chainu.

⚠️ jedinice: webhook `account.balance.changed` kaže "in wei", REST vraća stringove, kartični
iznosi su minor-units — kalibrirati na stvarnim payloadima prije ikakve matematike.

## IBAN / Monerium — kolizija s našim postojećim railom

GP nudi "IBAN za GP Safe" kao **tanki wrapper oko Moneriuma** (KYC passporting):
`GET /api/v1/ibans/available` → `GET /api/v1/ibans/signing-message` (potpisuje **verificirani
EOA**: "I hereby declare that I am the address owner.") → `POST /api/v1/integrations/monerium`.

**Ali**: "Monerium only allows the user to have one single account with them."

```mermaid
flowchart TD
    A[Korisnik želi IBAN za GP Safe] --> B{Ima li već Monerium profil<br/>kroz pay.domovina.ai?}
    B -- "da (naši postojeći korisnici)" --> C["NE zvati GP endpoint<br/>(past će na Monerium strani)"]
    C --> D["Link GP sign-in adrese na POSTOJEĆI<br/>Monerium profil direktno kroz Monerium API<br/>(mi smo već partner — ne treba GP)"]
    B -- ne --> E["GP-ov flow: POST /integrations/monerium<br/>(GP-ov KYC se šalje Moneriumu)"]
    E --> F["bankingDetails u GET /user:<br/>moneriumIban, BIC, status"]
    D --> F
    F --> G["SEPA uplata → EURe issuance<br/>na adresu registriranu za IBAN"]
```

Strateški zaključak: **IBAN funkcionalnost već imamo** (mi smo Monerium partner) — GP-ov IBAN
wrapper nam treba samo za korisnike koji uđu kroz karticu, a nemaju naš onramp. Smjer issuance
adrese (GP Safe vs DOMOVINA Safe) je stvar registracije adrese na Monerium profilu — **zadržati
DOMOVINA Safe kao primarni landing**, pa funding kartice ostaje naš kontrolirani transfer.

KYC sharing: **isključivo GP→partner** (tripartitni ugovor GP+Sumsub+partner; Noah, BRLA).
Naš Monerium KYC se NE može uvesti u GP. Za nas sharing nije potreban ni u jednom smjeru.

## Tajne (wrangler secrets)

| Tajna | Svrha | Higijena |
|---|---|---|
| `GNOSISPAY_PSE_KEY` | mTLS privatni ključ (EC P-256) | razina relayer ključa; trim/0x normalizacija N/A (PEM) |
| `GNOSISPAY_PSE_CERT` | potpisani cert chain | uz ključ |
| `GNOSISPAY_PARTNER_ID` | atribucija u signup + webhook rute | nije tajna ali env |
| (nema API keya) | GP nema partner API key — sve je SIWE/mTLS | — |
