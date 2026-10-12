# MPT sandbox: quickstart for developers

Self-serve test environment for integrating MPT payments (SEPA → EURe) into your app,
e.g. the Open SaaS MPT provider. No account, no bank, no Monerium: payments are
**simulated** by the rail and go through the same path as real ones, so you get the same
intent shape, the same checkout timeline and the same signed webhooks.
Design: [ADR 0024](../decisions/0024-samoposluzni-sandbox-i-return-url.md).

`MPT_API_URL` is `https://mpt.domovina.ai` today. A permanent alias stays when
`https://api.mpt.hr` arrives ([ADR 0021](../decisions/0021-mpt-hr-javni-hostovi-i-api-v1.md)).

## 1. Get sandbox keys

```bash
curl -s -X POST "$MPT_API_URL/api/sandbox/tenants" \
  -H 'content-type: application/json' \
  -d '{"name":"My SaaS (dev)","webhook_url":"https://my-tunnel.example/payments-webhook"}'
```

```json
{
  "tenant_id": "sbx-7f3a9c2e1b",
  "sandbox": true,
  "secret_key": "sk_test_…",
  "public_key": "pk_test_…",
  "webhook_secret": "whsec_…",
  "webhook_url": "https://my-tunnel.example/payments-webhook",
  "demo_target_address": "0x000000000000000000000000000000000000dEaD",
  "expires_at": "2027-01-10T12:00:00.000Z"
}
```

Keys and the webhook secret are shown **once**. `webhook_url` is optional (https only).
Without it, poll the intent instead (step 4). Limits: 5 tenants per IP per day; a tenant
expires after 90 days without activity.

Change or rotate the webhook later:

```bash
curl -s -X PUT "$MPT_API_URL/api/sandbox/webhook" -H "authorization: Bearer $MPT_SECRET_KEY" \
  -H 'content-type: application/json' -d '{"webhook_url":"https://…","rotate_secret":true}'
```

## 2. Create an intent (server side)

```bash
curl -s -X POST "$MPT_API_URL/api/intents" -H "authorization: Bearer $MPT_SECRET_KEY" \
  -H 'content-type: application/json' -d '{
    "target_address": "0x000000000000000000000000000000000000dEaD",
    "amount_eur": "9.90",
    "label": "10 credits",
    "metadata": { "userId": "u1", "paymentPlanId": "credits10" },
    "expires_in_seconds": 86400,
    "return_url": "http://localhost:3000/checkout"
  }'
```

Send the buyer to `checkout_url`. In the sandbox the response has `sandbox: true`,
`simulate_url`, and `iban` / `epc_qr_data` / `hub3_data` = `null`: no real money can be sent.

`return_url` requires the **secret** key. https only; `http://localhost`, `127.0.0.1` and
`[::1]` are allowed in the sandbox. The checkout sends the buyer back with
`?mpt_sid=<sid>&mpt_status=paid|expired|cancelled`. `mpt_status` is a hint for the UI only.
Grant credits only from a webhook or from the status you read yourself.

## 3. Simulate the payment

Use the buttons on the checkout page, or:

```bash
curl -s -X POST "$MPT_API_URL/api/intents/$SID/simulate" \
  -H 'content-type: application/json' -d '{"outcome":"paid"}'
```

| `outcome` | Events your webhook receives | Intent `state` |
|---|---|---|
| `paid` (default) | `payment.received` → `intent.paid` | `paid` |
| `received` | `payment.received` (call again with `paid` to finish) | `pending` |
| `underpaid` | `payment.received` → `payment.underpaid` (1 € short, or `amount_eur`) | `pending` |
| `late` | `payment.received` → `payment.late` (the intent expires first) | `expired` |
| `rejected` | `payment.received` → `payment.rejected` | `pending` |

Optional `amount_eur` sets what the simulated payer sends. One settlement per intent.

## 4. Confirm the payment

**Webhook** (Standard Webhooks): verify `webhook-signature` = `v1,` + base64
HMAC-SHA256 of `${webhook-id}.${webhook-timestamp}.${rawBody}`, keyed with the base64
part of `whsec_…`. Dedup on `webhook-id`. Grant credits on `intent.paid` (and on
`payment.late`, if you accept late money).

**Polling** (local development without a tunnel): from your **server**, call
`GET $MPT_API_URL/api/intents/<mpt_sid>` and grant credits when `state` is `paid`.
Make it idempotent on `sid`, the same as the webhook handler. No CORS is needed because
the call does not come from the browser.

## 5. Production

Production needs a real MPT tenant. You need your own Monerium account (KYB). MPT then
onboards your IBAN, Safe and webhook and issues `sk_…`. Replace `sk_test_…` with `sk_…`
and point the webhook secret at the production `whsec_…`. Nothing else changes. A test
key never works for a production tenant, and a production key never works for a sandbox
tenant.
