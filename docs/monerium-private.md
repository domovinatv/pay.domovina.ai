# Monerium Private — Single Source of Truth

This document captures the **full Monerium Private API contract** as it applies to `pay.domovina.ai` / ITalk d.o.o. It is the canonical reference for all backend implementation decisions. Update this file whenever Monerium docs change or new behavior is observed in the wild.

**Source**: https://docs.monerium.com/private (verified 2026-05-04).

**Account context** (from `/auth/context` on production):
- Profile kind: `corporate`, name: ITalk d.o.o.
- Permissions granted to the app: `read`, `write` on Wallets / IBAN / Orders
- The actual `userId`, `defaultProfile`, and App ID UUIDs are stored in environment variables / `.dev.vars` — never commit them.

---

## Environments

| Environment | API base | Web | Notes |
|---|---|---|---|
| Sandbox | `https://api.monerium.dev` | `https://sandbox.monerium.dev` | Mock data; no real money |
| Production | `https://api.monerium.app` | `https://monerium.app` | Real money. ITalk d.o.o. is on this. |

Wrangler env var: `MONERIUM_BASE_URL`.

## Required headers on every API request

```
Authorization: Bearer <access_token>
Accept: application/vnd.monerium.api-v2+json
Content-Type: application/json   (omit for x-www-form-urlencoded token requests)
```

**Without the `Accept` header you get the v1 API**, which 404s on `/profiles`, `/orders`, `/webhooks`. This is the most common silent footgun.

---

## Authentication — Client Credentials

```http
POST /auth/token
Content-Type: application/x-www-form-urlencoded
Accept: application/vnd.monerium.api-v2+json

grant_type=client_credentials&client_id=<id>&client_secret=<secret>
```

Response:
```json
{ "access_token": "...", "expires_in": 3600, "token_type": "Bearer" }
```

- TTL: 3600s. Cache in KV with `expirationTtl: expires_in - 60`.
- Backend-only. Never expose `client_secret` or `access_token` to frontend.

---

## Profile resolution

`/profiles` requires a scope our Private app lacks (returns **403** "does not have access to profile … with required scopes"). Don't rely on it.

**Use `/auth/context` instead**:
```http
GET /auth/context
```
Returns `{ defaultProfile, profiles: [...] }`. Use `defaultProfile` for all profile-scoped calls.

---

## Webhooks — full lifecycle

### Registration is API-only

There is **no UI** in `monerium.app` for webhook setup on Private apps. Only programmatic registration via `POST /webhooks`.

### Quirks discovered in production (2026-05-04)

These are NOT in the public docs and bit us hard:

1. **`POST /webhooks` silently substitutes the `types` array.** No matter what we send, the response shows `["iban.updated", "profile.updated"]`. **Workaround: always follow up with `PATCH /webhooks/{id}` to set the actual types.** PATCH honors `types`.
2. **`PATCH /webhooks/{id}` does NOT support updating `secret`.** Per the SDK type `UpdateWebhookSubscriptionInput = { subscription, state?, types? }` — no `secret` field. The secret is set ONCE at POST time and cannot be rotated without creating a new subscription.
3. **No DELETE endpoint.** `DELETE /webhooks/{id}` returns 404. To "delete", PATCH `{ "state": "inactive" }`. Inactive subscriptions retain the URL slot — to rotate URL or secret, register a new subscription with a different URL (query string suffix works, e.g. `?v=2`).
4. **`POST /webhooks` returns 400 "Invalid secret: unable to decode" if the secret isn't valid base64 after `whsec_` prefix.** Don't strip padding `=`. `cut -d= -f2` is dangerous — use `awk` to preserve trailing `=`.

### Generate the secret yourself

```js
const secret = 'whsec_' + crypto.randomBytes(32).toString('base64');
```

The `whsec_` prefix is part of the literal secret you pass to Monerium. The actual HMAC key is the **base64-decoded value after `whsec_`**.

### Register endpoint

```http
POST /webhooks
{
  "url": "https://your-app.com/webhooks/monerium",
  "secret": "whsec_<base64-32-bytes>",
  "types": ["order.created", "order.updated"]
}
```

**Field name is `types`, NOT `events`.** Mistake I made initially.

### Subscription confirmation

Monerium sends a `subscription.created` event to your URL **immediately after registration**. You must return `200 OK` to activate the subscription. If you don't, the subscription stays inactive.

### Signature verification — Standard Webhooks format

Headers on every event request:
```
webhook-id: <unique event id, used for idempotency>
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64-hmac>
```

Verification algorithm:
1. Form signed payload: `signedPayload = `${webhook-id}.${webhook-timestamp}.${rawBody}``
2. HMAC-SHA256 with key = `base64Decode(secret.slice('whsec_'.length))`
3. Base64-encode the HMAC output
4. Expected header value: `v1,<that base64>`
5. Constant-time compare against `webhook-signature`

**The `v1,` prefix is part of the comparison.** A header may contain multiple comma-separated signatures (`v1,sigA v1,sigB ...` for rotation); accept if any matches.

### Idempotency

Monerium retries failed deliveries up to **10 times over 12 hours** with exponential backoff. Store the `webhook-id` of every successfully processed event and skip re-processing on retry.

### Event types (Private app)

| Type | When fired | Use |
|---|---|---|
| `subscription.created` | Once, immediately after `POST /webhooks` | Return 200; no other action |
| `order.created` | When Monerium first detects an incoming/outgoing order (e.g., SEPA arrived at IBAN) | Early notification, before EURe is minted |
| `order.updated` | On every order state change (`placed` → `pending` → `processed` or `rejected`) | Primary handler — `processed` carries `meta.txHashes`, `rejected` carries `meta.rejectedReason` |

Profile approval is notified **by email**, NOT webhook.

### Event payload shape

```jsonc
{
  "type": "order.updated",
  "data": {
    "id": "uuid",
    "kind": "issue" | "redeem",
    "state": "placed" | "pending" | "processed" | "rejected",
    "amount": "1.05",
    "currency": "eur",
    "address": "0x...",
    "chain": "gnosis",
    "counterpart": { "identifier": { "standard": "iban" | "chain", ... }, "details": {...} },
    "memo": "...",
    "referenceNumber": "RF...",
    "meta": {
      "placedAt": "...",
      "processedAt": "...",
      "txHashes": ["0x..."],
      "rejectedReason": "..."
    }
  }
}
```

`state` is at top level on the order, **not inside `meta`** (older API versions kept it in meta — accept both for safety).

---

## IBAN

### Provision via API

```http
POST /ibans
{ "address": "0x...", "chain": "ethereum" | "gnosis" | "polygon" }
```

Returns `202` — provisioning is asynchronous; finalization arrives via email/dashboard, not webhook.

For ITalk's setup, the IBAN was provisioned via dashboard; programmatic creation is only needed when scaling to multi-tenant SaaS.

### Move IBAN to a different wallet/chain

```http
PATCH /ibans/{iban}
{ "address": "0x...", "chain": "gnosis" }
```

From that point onward, incoming SEPA mints to the new address.

### List linked IBANs

```http
GET /ibans
```

---

## Orders

Two kinds:

| Kind | Direction | Initiated by |
|---|---|---|
| `issue` | EUR → EURe (mint) | **Monerium**, automatically when SEPA hits IBAN or EURe is received cross-chain |
| `redeem` | EURe → EUR or EURe → other chain | **Our app**, via signed `POST /orders` |

### List orders

```http
GET /orders?profile={profileId}
```

Returns `{ "orders": [...] }` — wrapped in an envelope, not a bare array.

### Get a single order

```http
GET /orders/{id}
```

Returns the order object directly.

### Incoming SEPA → EURe (issue, automatic)

We don't initiate this. Monerium creates the `issue` order automatically when SEPA arrives.

**Memo-based routing**: senders can override default mint destination by including `<chain>:<address>` in the SEPA memo, e.g.:
```
gnosis:0x59cFC408d310697f9D3598e1BE75B0157a072407
```
If the address is linked on that chain, EURe mints there instead of the IBAN's default-linked address.

We've observed this in production data — outgoing reconciliation pings used `gnosis:<address>` memos to direct mints.

### Outgoing SEPA (redeem)

```jsonc
POST /orders
{
  "address": "0x...",            // wallet holding the EURe to burn
  "currency": "eur",
  "chain": "ethereum",            // or "gnosis", "polygon"
  "kind": "redeem",
  "amount": "100.00",
  "counterpart": {
    "identifier": { "standard": "iban", "iban": "EE521273842688571285" },
    "details": { "firstName": "Jane", "lastName": "Doe", "country": "EE" }
    // OR for corporate: { "companyName": "Acme Ltd", "country": "EE" }
  },
  "message": "Send EUR 100.00 to EE521273842688571285 at 2024-07-12T12:02Z",
  "signature": "0x...",           // EOA personal_sign over `message`
  "memo": "Invoice #1234",        // optional, free text on bank statement
  "referenceNumber": "RF18539007547034" // optional, ISO 11649
}
```

**`memo` and `referenceNumber` are mutually exclusive** — if both present, `referenceNumber` wins and `memo` is ignored.

If neither is provided, Monerium sets memo to "Powered by Monerium".

### Cross-chain redeem (bridging)

Same `POST /orders`, but `counterpart.identifier.standard = "chain"`:

```jsonc
{
  "address": "0x...",   // source wallet, on `chain` below
  "currency": "eur",
  "chain": "ethereum",
  "kind": "redeem",
  "amount": "100.00",
  "counterpart": {
    "identifier": {
      "standard": "chain",
      "address": "0x...",
      "chain": "gnosis"  // destination chain
    }
    // no `details` needed
  },
  "message": "Send EUR 100.00 to 0x... on gnosis at ...",
  "signature": "0x..."
}
```

Monerium internally creates a redeem on source + dependent issue on destination. **Monitor only the redeem** — its final state and `meta.txHashes` cover the full bridge.

### Signing rules (redeem)

Every redeem requires a signed message from the wallet holding the EURe.

**SEPA**:
```
Send <CURRENCY> <AMOUNT> to <IBAN> at <TIMESTAMP>
```

**Cross-chain**:
```
Send <CURRENCY> <AMOUNT> to <ADDRESS> on <CHAIN> at <TIMESTAMP>
```

Timestamp: RFC3339 UTC, **minute precision** (no seconds), within +5 min of now or any future time. Set 1–2 min ahead to absorb network latency.

IBAN may be full (no spaces) or shortened (`EE12...2602`).

EOA wallets sign with `eth_sign` / `personal_sign`. Smart contract wallets use EIP-1271 (off-chain or on-chain).

### Orders ≥ €15 000

Require a supporting document (invoice/contract). Upload via `POST /files` first, then include `supportingDocumentId: <fileId>` in the order payload.

---

## Wallet linking

Required before an address can hold EURe / receive incoming mints / sign redeems.

```http
POST /addresses
{
  "profile": "<profileId>",
  "address": "0x...",
  "chain": "ethereum",
  "message": "I hereby declare that I am the address owner.",
  "signature": "<personal_sign over the fixed message>"
}
```

The message is a **fixed literal**: `I hereby declare that I am the address owner.`

| Wallet type | How to sign | Result |
|---|---|---|
| EOA | private key signs the fixed message | 65-byte ECDSA signature |
| Smart contract — off-chain | owners assemble combined signature; Monerium verifies via EIP-1271 `isValidSignature` | 201 |
| Smart contract — on-chain | broadcast `signMessage` tx; submit `"0x"` as signature; Monerium polls EIP-1271 up to 5 days | 202 |

---

## Going live (Private app)

No partner review needed. Steps:

1. KYC (individuals) or KYB (businesses) at `monerium.app/profiles` — ITalk d.o.o. ✅ done
2. Create production app at `monerium.app` (separate from sandbox app)
3. Once profile is approved, production credentials are active immediately

---

## Backend implementation notes (this repo)

### File map

| Concern | File |
|---|---|
| OAuth + API client | `backend/src/monerium/client.ts` |
| Webhook signature verification | `backend/src/monerium/webhook.ts` |
| DB upserts + audit log | `backend/src/monerium/db.ts` |
| Types | `backend/src/monerium/types.ts` |
| Routes (webhook ingest, list orders, admin) | `backend/src/index.ts` |
| Schema | `backend/migrations/0002_monerium.sql` |

### Env vars

```
MONERIUM_BASE_URL          # https://api.monerium.app (prod) | https://api.monerium.dev (sandbox)
MONERIUM_CLIENT_ID         # from monerium.app/developers/apps
MONERIUM_CLIENT_SECRET     # from monerium.app/developers/apps
MONERIUM_WEBHOOK_SECRET    # whsec_<base64-32-bytes>; we generate, send to Monerium on subscription
MONERIUM_PROFILE_ID        # optional override; otherwise resolved from /auth/context
```

### Endpoints exposed by our backend

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/monerium/webhook` | Signature header | Receives Monerium events. Verifies signature, dedupes by `webhook-id`, upserts order. Always returns 200 (even on bad signature) so Monerium doesn't retry unnecessarily — we just don't process. **Exception**: signature errors return 401. |
| `GET` | `/api/monerium/orders` | Public | Lists cached orders from D1 |
| `GET` | `/api/monerium/orders/:id` | Public | Single order |
| `POST` | `/api/monerium/admin/sync` | Bearer | Pull-based backfill from `/orders`; safe to run as cron |
| `GET` | `/api/monerium/admin/auth-context` | Bearer | Inspect `/auth/context` |
| `GET` | `/api/monerium/admin/profiles` | Bearer | (Currently 403 — see Profile resolution above) |
| `GET` | `/api/monerium/admin/webhooks` | Bearer | List existing subscriptions |
| `POST` | `/api/monerium/admin/webhooks` | Bearer | Register a webhook URL with Monerium |

### DB schema

- `monerium_orders` — latest snapshot per order, upserted on every event (key: `id`)
- `monerium_webhook_events` — append-only log of every received event with `signature_ok` flag
- `monerium_processed_event_ids` — idempotency record of `webhook-id` values we've already handled

### Signature verification specifics

Implemented in `backend/src/monerium/webhook.ts`:

1. Read `webhook-id`, `webhook-timestamp`, `webhook-signature` headers
2. Build `signed = ${id}.${timestamp}.${rawBody}`
3. Strip `whsec_` prefix from secret, base64-decode the rest → HMAC key
4. HMAC-SHA256(key, signed) → base64-encode → expected
5. Parse `webhook-signature` as space-separated `vN,<base64>` tokens; constant-time compare each against `v1,<expected>`

### Idempotency

Before processing an event, check `monerium_processed_event_ids` for the `webhook-id`. If present, return 200 without re-applying. Otherwise process, then insert the id.

### Cron (Cloudflare scheduled handler)

`wrangler.toml` has `crons = ["0 */6 * * *"]`. The `scheduled` handler currently calls `refreshAllAccounts` (HPB/Enable Banking) only — should also call Monerium sync as a safety net for missed webhooks. **TODO**.

---

## Quick reference — common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| 404 on `/profiles`, `/orders`, `/webhooks` | Missing v2 Accept header | Always send `Accept: application/vnd.monerium.api-v2+json` |
| 403 on `/profiles` "with required scopes" | Private app lacks `profiles:read` scope | Use `/auth/context` instead |
| `orders is not iterable` | API returns `{ orders: [...] }` envelope | Unwrap |
| Webhook signature never matches | Wrong header names / wrong encoding / forgot to strip `whsec_` and base64-decode | Follow Standard Webhooks spec exactly |
| Subscription registered but no events | Didn't return 200 to `subscription.created` | Handler must accept any event type and return 200 if signature OK |
| Event processed twice | Forgot dedupe by `webhook-id` | Insert-on-conflict on `monerium_processed_event_ids` |

---

## Observed production behavior (verified 2026-04-30 / 2026-05-04)

Cross-checked against live ITalk data (redacted for privacy — see local D1 for raw values):

- `state` field is at top level on the order, not nested in `meta`.
- Memo-based mint routing works: senders include `gnosis:0x<address>` in SEPA memo and Monerium honors it on `issue`.
- `referenceNumber` is preserved through the SEPA leg and surfaces in Monerium's order payload — useful for reconciliation tags (e.g. mapping payments to source-bank exports).
- Webhook timing: `order.created` arrives within 4-5 seconds of SEPA Instant arrival; `order.updated` (`processed`) follows once the on-chain mint confirms — typically 5-15 seconds later on Gnosis.
