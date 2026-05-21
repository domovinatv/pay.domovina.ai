# Payment intents + realtime checkout — engineering specification

_Captured: 2026-05-21. Phase 1 (D1 + polling) targeted for immediate
implementation. Phase 2 (Durable Object + SSE) designed in this doc
for the next iteration._

## TL;DR

- A **payment intent** is a server-side record of "buyer X intends to
  pay €Y to target Z, identified by `sid`." Created via `POST /api/intents`,
  carries a unique `sid` baked into the SEPA remittance, transitions
  `pending → paid` (or `expired`) based on Monerium webhook arrivals.
- **Buyer flow** = otp.domovina.ai SMS verification flow, but for
  money: open checkout page → see QR + countdown → scan → pay → wait
  → success modal with on-chain proof.
- **Phase 1 (MVP)**: D1-only storage, browser polls
  `GET /api/intents/:sid` every 2 seconds. Ships in hours.
- **Phase 2 (proper)**: Durable Object holds open SSE streams keyed by
  `sid`; webhook handler pushes `paid` event instantly via `DO.notify`.
  Sub-second latency, scales to thousands of concurrent checkouts.
- **Three surfaces**: `pay.domovina.ai` (existing Flutter DIY tool —
  unchanged for now), `mpt.domovina.ai/checkout/<sid>` (NEW, branded
  Hono-rendered buyer page), `mpt.domovina.ai/admin/intents` (NEW
  fourth tab in operator dashboard).

## 1. Motivation

The current MPT pipeline is well-instrumented on the operator side
(webhook events table, forwards table, admin dashboard) but **invisible
to the buyer**. After paying via Revolut, the buyer has no in-browser
confirmation that their payment arrived — they must trust that the
recipient saw it.

By introducing payment intents, MPT becomes a real PSP: every payment
attempt is a first-class object with a state machine, a deterministic
URL, and (Phase 2) realtime status updates. This is the same UX
pattern that `otp.domovina.ai` ships for SMS verification.

It also unlocks downstream integrations (Shopify, WooCommerce, webshop
checkouts) which need a stable API: `POST` to create an intent, get
back a `checkout_url`, redirect the buyer.

## 2. State machine

```
                    ┌────────────────────────────────────────┐
                    │                                         │
   POST /intents    │                                         ▼
   ───────────────► [pending]                            [expired]
                        │  (TTL=15 min by default, sweep cron)
                        │
                        │  Monerium webhook arrives with sid match
                        │  AND forward succeeds on-chain
                        ▼
                    [paid]
```

- **`pending`** — intent created, awaiting payment. Browser polls
  (Phase 1) or holds SSE stream (Phase 2). TTL countdown visible.
- **`paid`** — Monerium webhook for an `order.updated` with
  `state=processed` matched this intent's `sid`, forward succeeded,
  on-chain TX hash recorded. Terminal.
- **`expired`** — TTL passed without payment. Terminal. Buyer can't
  pay anymore — intent is dead, sid won't be matched even if a SEPA
  payment with that sid arrives later (those become orphan forwards,
  visible in admin but not auto-matched).

Optional future states (out of scope for Phase 1/2):

- `partial` — payment for less than `amount_eur` arrived (Monerium
  webhook delivered, sid matched, but amount mismatch)
- `overpaid` — payment for more than `amount_eur` arrived
- `refund_requested` / `refunded` — post-payment lifecycle
- `cancelled` — buyer or merchant aborts before payment

Phase 1 only handles `pending → paid | expired`; everything else is
recorded as `paid` (we keep the EURe regardless of amount mismatch)
plus an `amount_mismatch` flag in metadata that the admin surfaces.

## 3. Database schema (D1)

New migration `0007_payment_intents.sql`:

```sql
CREATE TABLE payment_intents (
  sid TEXT PRIMARY KEY,                  -- 10-32 char URL-safe id (matches sid format in memo)
  target_address TEXT NOT NULL,          -- lowercased 0x address; routing destination
  amount_cents INTEGER NOT NULL,         -- expected EUR amount × 100
  currency TEXT NOT NULL DEFAULT 'eur',  -- room for future GBP/USD intents
  label TEXT,                            -- merchant-supplied human-readable description
  metadata_json TEXT,                    -- merchant-supplied JSON blob (order_id, customer_email, ...)
  state TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'expired'
  created_at INTEGER NOT NULL,           -- unix seconds
  expires_at INTEGER NOT NULL,           -- unix seconds, used by sweep + UI countdown
  -- Populated when state transitions to 'paid':
  paid_at INTEGER,                       -- unix seconds of forward.confirmed
  monerium_order_id TEXT,                -- which Monerium order matched
  forward_id INTEGER,                    -- FK to monerium_forwards.id
  forward_tx_hash TEXT,                  -- 0x... Gnosis TX hash for the EURe transfer
  amount_received_cents INTEGER          -- actually received amount (may differ from amount_cents)
);

CREATE INDEX idx_intents_state_expires
  ON payment_intents(state, expires_at)
  WHERE state = 'pending';

CREATE INDEX idx_intents_target
  ON payment_intents(target_address, created_at DESC);

CREATE INDEX idx_intents_paid_at
  ON payment_intents(paid_at DESC)
  WHERE paid_at IS NOT NULL;
```

## 4. API design

### `POST /api/intents` — create intent

Public endpoint. Returns enough info for the caller (merchant backend
or operator) to render a checkout URL or QR.

Request:
```json
{
  "target_address": "0x6693a7D19486Dc45e9F90Fd2D515d972bBA2d65e",
  "amount_eur": "1.02",
  "label": "Donation to Project X",
  "metadata": { "order_id": "INV-001", "customer_email": "buyer@example.com" },
  "expires_in_seconds": 900
}
```

Response:
```json
{
  "sid": "k9m4p2x7w3",
  "checkout_url": "https://mpt.domovina.ai/checkout/k9m4p2x7w3",
  "epc_qr_data": "BCD\n001\n1\nSCT\nLHVBEE22\n...",
  "memo": "mpt:0x6693a7D1...?sid=k9m4p2x7w3",
  "iban": "EE7077770001629211 28",
  "amount_eur": "1.02",
  "expires_at": "2026-05-21T13:15:00Z",
  "state": "pending",
  "status_url": "https://mpt.domovina.ai/api/intents/k9m4p2x7w3",
  "status_stream_url": "https://mpt.domovina.ai/api/intents/k9m4p2x7w3/stream"
}
```

Validation:
- `target_address` — EIP-55 valid OR all-lowercase (no checksum claim)
- `amount_eur` — positive decimal, max 2 decimal places, ≤ €10,000
  (MVP — bigger amounts require Phase 2 Safe API multisig propose
  per `PHASE-2-SAFE-API.md`)
- `expires_in_seconds` — 60 to 86400 (1 min to 24 hours). Default 900
  (15 min, matches PayCek window).
- `label`, `metadata` — optional, sanitised.

Errors:
- `400` malformed body
- `400` invalid target address (EIP-55 fail with no-lowercase fallback)
- `429` rate-limited if same caller IP creates too many intents/minute
  (Phase 2 — skip for MVP)

### `GET /api/intents/:sid` — status snapshot

Public endpoint. Returns current state without subscribing. Used by:
- Polling clients (Phase 1)
- SSE resume / fallback (Phase 2)
- Webshop confirmation pages
- Operator scripts

Response shape mirrors the intent row (same fields as create response
+ all the `paid_at` / `forward_tx_hash` / etc fields once paid).

Caching: `Cache-Control: no-store` — state changes are time-sensitive.

### `GET /api/intents/:sid/stream` — SSE stream (Phase 2)

Server-Sent Events stream. Emits one initial `event: status` with
current snapshot, then any subsequent state changes, then closes.

Phase 1 implementation: returns `404` (not implemented yet). Client
falls back to polling automatically.

Phase 2 implementation: routes to a Durable Object `IntentHub` which
holds the open `ReadableStream` controllers keyed by `sid`. See
section 7.

### Admin endpoints (internal, Basic Auth gated)

- `GET /admin/intents` — HTML page
- `GET /admin/api/intents` — JSON list with filters
- `GET /admin/intents/:sid` — HTML detail page

### Out of scope (future)

- `POST /api/intents/:sid/cancel` — merchant aborts pending intent
- `POST /api/intents/:sid/refund` — reverse flow
- `POST /api/intents/:sid/extend` — extend expiry
- API key authentication for `POST /api/intents` (currently open;
  rate-limit by IP)

## 5. Buyer-facing checkout page (`mpt.domovina.ai/checkout/<sid>`)

Server-rendered Hono HTML page, branded in DOMOVINA palette. Layout
mirrors `otp.domovina.ai`'s code-display card with adaptations:

```
┌────────────────────────────────────────────┐
│   [tricolor stripe]                        │
│                                            │
│   DOMOVINA.ai · MPT                       │
│                                            │
│   ┌─ Plaćanje na čekanju ────────────┐    │
│   │                                  │    │
│   │  Skenirajte ovaj EPC QR kod      │    │
│   │  Revolutom ili bankarskom app:   │    │
│   │                                  │    │
│   │      [ █▀▀▀▀▀▀▀▀▀▀▀▀█ ]         │    │
│   │      [ █  EPC QR code █ ]         │    │
│   │      [ █▄▄▄▄▄▄▄▄▄▄▄▄█ ]         │    │
│   │                                  │    │
│   │  Iznos: 1,02 EUR                 │    │
│   │  Primatelj: 0x6693a7D1…2d65e     │    │
│   │  Reference: mpt:0x6693a7D1…sid…  │    │
│   │                                  │    │
│   │  [progress pulse animation]      │    │
│   │  Istječe za: 14:32               │    │
│   │                                  │    │
│   └──────────────────────────────────┘    │
│                                            │
│   [tricolor stripe]                        │
└────────────────────────────────────────────┘

   ↓ on payment confirmation ↓

┌────────────────────────────────────────────┐
│         [overlay, fades in]                │
│                                            │
│            ┌──────────────┐               │
│            │      ✓        │               │
│            │  (animated)   │               │
│            └──────────────┘               │
│                                            │
│            Plaćeno!                        │
│                                            │
│   1,02 EURe stiglo na primateljev wallet  │
│                                            │
│   [Pogledaj transakciju na Gnosisscanu →] │
│                                            │
└────────────────────────────────────────────┘
```

Technical details:

- **No Flutter** — pure Hono-rendered HTML + tiny inline JavaScript.
  Allows lightweight embedding by webshops (an iframe of
  `mpt.domovina.ai/checkout/<sid>` is sub-100KB).
- **EPC QR rendered client-side** with a small QR library
  ([qrjs2](https://github.com/davidshimjs/qrcodejs) or similar, ~5KB)
  bundled inline. Avoids a server round-trip for the image.
- **Polling (Phase 1)**: `fetch('/api/intents/:sid')` every 2 seconds,
  diff state, update UI.
- **SSE (Phase 2)**: `new EventSource('/api/intents/:sid/stream')`,
  listen for `status` events. Fallback to polling if `EventSource`
  unavailable or returns 404.
- **Audio chime + vibration** on `paid` transition (lifted directly
  from `otp.domovina.ai`'s `playSuccessChime()` pattern).
- **`<meta http-equiv="refresh" content="900">`** as backstop — if all
  JS fails, page reloads at expiry and shows expired state.

## 6. Admin tab (`mpt.domovina.ai/admin/intents`)

Fourth tab alongside Events / Orders / Forwards. Same look as the
existing three. Columns:

| # | Created | Status | Iznos | Target | Label | SID | Forward TX |
|---|---|---|---|---|---|---|---|
| #42 | 13:15 | [paid pill green] | 1,02 € | 0x6693…2d65e | Donation | k9m4p… | [0xc892… → Gnosisscan] |
| #41 | 12:58 | [pending pill amber] | 5,00 € | 0xabc1…9999 | — | a3b7q… | — |

Filters: status (all / pending / paid / expired), search by sid /
target / label. Auto-refresh toggle (5s). Click row → detail page
showing full intent JSON + linked forward row + linked Monerium
events.

## 7. Durable Object SSE (Phase 2 design)

### Why DO is necessary

Workers are stateless across invocations. Webhook arrives at random
Worker instance A; browser SSE connection lives on random Worker
instance B. There is no pub/sub between Worker instances. Without DO,
A cannot push to B.

DO solves this: `idFromName('intent-hub-global')` deterministically
routes any request from any Worker instance to the SAME DO instance,
which holds the SSE connection state in memory.

### Class sketch

```typescript
export class IntentHub {
  // sid → SSE stream controllers (multiple controllers per sid OK —
  // buyer could open checkout in multiple tabs)
  private subscribers = new Map<string, Set<ReadableStreamDefaultController>>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // /subscribe/:sid — long-lived SSE response
    if (url.pathname.startsWith('/subscribe/')) {
      const sid = url.pathname.split('/').pop()!;
      return this.openStream(sid);
    }

    // /notify/:sid — fire-and-forget push
    if (url.pathname.startsWith('/notify/')) {
      const sid = url.pathname.split('/').pop()!;
      const body = await req.text();
      this.broadcast(sid, body);
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }

  private openStream(sid: string): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: (controller) => {
        const set = this.subscribers.get(sid) ?? new Set();
        set.add(controller);
        this.subscribers.set(sid, set);

        // Heartbeat to keep proxies happy (15s)
        const heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(': ping\n\n')); }
          catch { clearInterval(heartbeat); }
        }, 15_000);

        // Auto-close after 30 min — paranoid backstop
        setTimeout(() => controller.close(), 30 * 60 * 1000);
      },
      cancel: (controller) => {
        for (const [sid, set] of this.subscribers) {
          set.delete(controller);
          if (set.size === 0) this.subscribers.delete(sid);
        }
      }
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      }
    });
  }

  private broadcast(sid: string, eventData: string) {
    const set = this.subscribers.get(sid);
    if (!set) return;
    const encoder = new TextEncoder();
    const payload = encoder.encode(`event: status\ndata: ${eventData}\n\n`);
    for (const ctrl of set) {
      try { ctrl.enqueue(payload); }
      catch { /* dropped — cancel callback will clean up */ }
    }
  }
}
```

Worker integration in webhook handler:

```typescript
// After forward succeeds and intent.state = 'paid'
const hub = env.INTENT_HUB.get(env.INTENT_HUB.idFromName('global'));
await hub.fetch(new Request(`https://hub/notify/${sid}`, {
  method: 'POST',
  body: JSON.stringify({ state: 'paid', tx_hash, paid_at })
}));
```

### Why this works

- All SSE connections cluster on one DO instance — broadcasts are
  in-memory map lookups
- Webhook handler (running on a random edge Worker) does ONE RPC call
  to the DO; DO does the fan-out
- Latency: webhook arrives → DO notify call ~5-10ms → SSE push to
  browser ~50-100ms total. Sub-second user-perceived latency.

### Scale notes

- DO handles tens of thousands of concurrent SSE connections in
  practice
- Memory cost per subscriber ~few KB (controller + closure)
- If we ever need more, shard by `sid % N` into N DO instances
  (idFromName(`intent-hub-${shard}`))
- DO billing is wall-time + requests; SSE idle = essentially free in
  CPU, ~$0.05/GB-month for memory at our scale

## 8. Implementation phases

### Phase 1 — Polling MVP (target: ship today)

- Migration 0007 (D1 table)
- DB helpers: `createIntent`, `getIntent`, `markIntentPaid`, `listIntents`, `sweepExpired`
- `POST /api/intents` + `GET /api/intents/:sid`
- Webhook handler: after forward `submitted/confirmed`, also call
  `markIntentPaid(sid, ...)` (idempotent)
- Branded `/checkout/:sid` Hono page with polling
- Admin `/admin/intents` tab
- Cron-based sweep (existing `scheduled` handler) marks expired
  intents

### Phase 2 — SSE upgrade (target: next iteration)

- `IntentHub` Durable Object class + binding in `wrangler.toml`
- New migration if any state needs to persist in DO storage (probably
  no — SSE is ephemeral, all durable state stays in D1)
- `GET /api/intents/:sid/stream` proxies to DO
- Webhook handler calls `DO.notify` after `markIntentPaid`
- Checkout page switches from polling to `EventSource`, polling
  becomes fallback

### Phase 3 — Webshop integrations (after Phase 1+2)

Per the [shopify-woocommerce-gateway](../integrations/shopify-woocommerce-gateway.md)
doc:

- WooCommerce plugin calls `POST /api/intents` on order placement,
  redirects buyer to `checkout_url`
- Shopify manual method + `orderMarkAsPaid` mutation triggered by
  MPT outbound webhook with `sid`
- Outbound webhook signed with HMAC (Standard Webhooks compat)

### Phase 4 — Per-event Safe factory + SDK (per
[per-event-safe-rail](./per-event-safe-rail.md))

Out of scope for this doc; design lives in the linked file.

## 9. Operational considerations

### TTL sweep

Cron fires every 6 hours (existing `crons = ["0 */6 * * *"]` in
`wrangler.toml`). Sweep query:

```sql
UPDATE payment_intents
   SET state = 'expired'
 WHERE state = 'pending'
   AND expires_at < strftime('%s','now');
```

Doesn't delete rows — kept indefinitely for audit. Could add a
retention policy at 1 year.

### Late-arriving payments after expiry

If a buyer pays AFTER expiry, the Monerium webhook still fires and
the backend still forwards EURe to the target (Phase 1 forward logic
doesn't check intents — it forwards based on memo). The intent stays
`expired`, but the forward row exists. Admin can see this and reconcile.

This is **intentional** — funds must always be routed if possible;
the intent UI just won't show success because the timer ran out.

### Webhook reordering

Monerium may fire `order.updated` (state=processed) before our backend
finishes processing `order.created`. The current webhook handler is
idempotent on order_id. Intent lookup by `sid` is also idempotent (UPDATE
only sets `state='paid'` if currently `pending`). No special handling
needed.

### sid collisions

Generate `sid` with `crypto.randomUUID()` then slice to 10-12
URL-safe chars from a 30-char alphabet (no `0/O/1/l/I` to avoid
human confusion). Collision probability after 1M intents ≈ negligible.
INSERT on `payment_intents` will fail with unique constraint if
collision occurs → backend retries with fresh sid (max 3 attempts).

### Rate limiting on intent creation

Phase 1 skips this. Phase 2: per-IP token bucket (10 intents/min per
IP). Implement via DO with a sliding window. Spam from one IP burns
their tokens but doesn't affect anyone else.

## 10. References

- [otp.domovina.ai SMS verification flow](https://github.com/...) — the
  UX pattern we're mirroring
- [per-event-safe-rail.md](./per-event-safe-rail.md) — the bigger
  product story; intents are the foundation for that
- [PHASE-2-SAFE-API.md](../../backend/safe-tx/PHASE-2-SAFE-API.md) —
  high-value intent escalation to multisig propose
- [shopify-woocommerce-gateway.md](../integrations/shopify-woocommerce-gateway.md)
  — webshop integration that consumes the intent API
- Cloudflare Workers streaming response API: https://developers.cloudflare.com/workers/runtime-apis/response/#streaming-response-bodies
- Cloudflare Durable Objects: https://developers.cloudflare.com/durable-objects/
- W3C Server-Sent Events spec: https://www.w3.org/TR/eventsource/
- MDN EventSource: https://developer.mozilla.org/en-US/docs/Web/API/EventSource
