# Per-event Safe rail — MPT product vision

_Captured: 2026-05-21. Not implemented. This document records the
architectural insight + operational considerations so the team can
re-engage with the idea later or share it with prospective partners
(entrio.hr, ticketing platforms, donation platforms, crowdfunding,
campaign payments)._

## TL;DR

**Each addressable payment destination — a concert, a fundraising
campaign, a freelancer's gig, a SaaS subscription, an invoice — gets
its own Safe multisig on Gnosis chain. EUR-denominated SEPA payments
land in MPT's main-rail Safe via Monerium mint, then the MPT backend
routes EURe to the destination Safe via Zodiac Roles. Per-payment
`sid` in the SEPA remittance carries the merchant's order ID, enabling
attribution back to the buyer/order on the webshop side.**

The model treats each event/campaign as if it had its own bank account
— but the "account" is an on-chain multisig, its ledger is public and
authoritative, and capital arrives instantly without intermediary
holding.

## Why this matters (vs PayCek-style)

Conventional crypto payment processors (PayCek, BitPay, NowPayments,
Coinbase Commerce) settle everything to one merchant pool, then
reconcile per-order via the PSP's internal database. The processor is
the source of truth; if their database is wrong or their support is
slow, the merchant is stuck.

A per-event Safe inverts the trust model:

| Aspect | Classical PSP (PayCek-style) | Per-event Safe model |
|---|---|---|
| Bookkeeping authority | PSP's database | On-chain Safe balance |
| Audit trail | PSP export + merchant DB | Public on-chain history per Safe |
| Capital flow | Funds parked in PSP escrow, settle batch | Instant landing in event Safe |
| Refunds | PSP API call, manual ops | Safe owners directly co-sign refund TX |
| Custody | PSP holds keys | Event organisers hold multisig keys |
| Split payments | Off-chain bilateral agreement | Zodiac module on event Safe enforces on-chain |
| KYC scope | Per merchant entity | Per Safe (potentially per event) |
| Counterparty risk | PSP solvency | Multisig threshold + signer key safety |

This is **structurally** better in ways classical PSPs cannot match
without giving up custody. The "event has its own bank account" mental
model is also more intuitive for end users than "merchant has many
payment IDs."

## End-to-end flow (example: entrio.hr ticketing)

```
[ Organiser creates event in entrio admin ]
   ↓ POST /api/events { name, organiser, ... }
[ entrio backend ] → MPT factory endpoint creates a new Safe on Gnosis
                     (threshold 1 default — organiser is sole owner;
                      or 2/N with co-organisers as additional signers)
   ↓ returns event_safe_address
[ event published with checkout URL ]

[ Buyer reaches checkout for ticket €25 ]
   ↓ entrio backend creates order_id, calls MPT to generate EPC QR with:
      memo:   mpt:<event_safe_address>?sid=<entrio_order_id>
      amount: 25.00
      iban:   EE7077770001629211 28 (Monerium / LHV)
   ↓ EPC QR rendered for buyer
[ Buyer scans with Revolut, pays €25 ]

[ Monerium receives SEPA payment ]
   ↓ mints 25 EURe to MPT main-rail Safe (always)
   ↓ webhook → MPT backend
[ MPT backend parses memo, extracts target = event_safe_address ]
   ↓ Roles.execTransactionWithRole(EURe.transfer(event_safe, 25_eure))
   ↓ EURe lands in event Safe ~10s after fiat receipt
[ MPT backend POSTs to entrio webhook ]
   { sid: "entrio_order_id", target, amount, tx_hash, confirmed_at }
[ entrio backend marks order paid, emails buyer the QR ticket ]
```

End state: organiser's Safe holds the 25 EURe. Buyer can verify
on-chain that their payment reached the event Safe. Organiser can
swap, hold, withdraw via Monerium redeem, or split via Zodiac module
— their call, their custody.

## What MPT already supports out of the box

Counter-intuitively, the per-event Safe model maps **1:1 onto the
current production architecture** with no on-chain or backend code
changes:

- **Memo format**: `mpt:<any_address>?sid=<any_string>` already works.
  The current `extractRoutingTarget()` in `src/monerium/sid.ts` does
  not care whether the target is a personal EOA, a Safe multisig, or
  a contract — it just parses the address.
- **Forward execution**: `forwardViaSafe()` in `src/router/safe.ts`
  submits `EURe.transfer(target, amount)` via the Roles Modifier. Any
  valid address as target works.
- **Audit log**: `monerium_forwards` table already indexes by
  `target_address` — grouping forwards by destination Safe is one
  SQL query.
- **Idempotency + retry**: the `order.updated` + `state=processed`
  trigger plus idempotency check (added 2026-05-21) handle every
  forward identically regardless of target type.

**The architectural surface area is already correct.** What's missing
is the product layer that hangs off it.

## What needs implementation (priority order)

### Phase A — Make event Safes first-class (≈3 days)

1. **Event Safe factory endpoint** (`POST /api/events`)
   - MPT backend uses `@safe-global/protocol-kit` to deploy a 1-of-1
     Safe on Gnosis chain for the requester
   - Optional: caller passes `additional_owners[]` + `threshold` for
     multisig configurations
   - Returns `{event_safe_address, deployment_tx_hash, owner_key (if
     factory-generated)}`
   - Stored in new D1 table `mpt_event_safes(address, owner, label,
     created_at)` for reverse lookup + analytics
   - Gas cost ~$0.05/Safe on Gnosis — negligible at any volume; could
     be subsidised by MPT or passed through

2. **MPT outbound webhook** (`POST <merchant_callback_url>`)
   - After a `forwardViaSafe` succeeds (status → `confirmed`), POST
     the merchant's registered callback URL with `{sid, target,
     amount_eur, amount_wei, tx_hash, confirmed_at}`
   - HMAC-signed with merchant-specific secret (same pattern as
     Monerium webhooks → us)
   - Retries with exponential backoff if merchant returns non-2xx
   - New D1 table `mpt_merchant_callbacks(merchant_id, url, secret,
     callback_status)` to track delivery

3. **Per-Safe analytics view in admin** (`/admin/safes/:address`)
   - Already 90% there — `listForwards()` accepts target filter
   - New tab in admin UI showing per-Safe forwards aggregated by day,
     total received, distinct sids count
   - Useful for organiser-facing dashboard reuse

### Phase B — Merchant integration SDK (≈1 week)

4. **TypeScript SDK package**: `@mpt/checkout-sdk`
   - `MptCheckout({apiKey})` client
   - `.createEventSafe({name, owners, threshold})` → wraps factory call
   - `.createCheckout({eventSafe, amount, orderId, currency})` →
     returns `{epc_qr_data, expected_memo, sid}`
   - `.verifyWebhook(headers, body, secret)` → HMAC validator
   - Published to npm as zero-dep ESM module
   - Mirrors the simplicity of Stripe.js for adoption ease

5. **Reference integration**: example wired into a stub e-commerce
   site (basic Next.js with `@mpt/checkout-sdk` glued to the cart)
   — used as a portable demo when pitching webshops

### Phase C — Programmable post-payment (later, when there's demand)

6. **Zodiac module presets** per event Safe (escrow, split, timelock)
   - "Don't release funds before event date" — Zodiac Delay module
   - "Split 60/30/10 between organiser/venue/artist" — custom
     Distribute module
   - "Auto-yield while waiting" — sDAI wrapping module
   - All optional, per-Safe configuration via Safe Apps

7. **Cross-event aggregation queries** for accountant/regulator
   - Read-only API: "all forwards from MPT main-rail to any event Safe
     owned by user X between dates Y/Z"

## Operational concerns

### Who deploys the event Safe + owns the keys

Simplest model: **MPT backend deploys a 1-of-1 Safe for the merchant,
passes the owner key in a one-time secure delivery (email link with
time-limited token + recommendation to import to Safe Mobile
immediately).** This gives the merchant full custody from minute one,
no MPT lock-in.

More advanced: BYO Safe — merchant deploys their own Safe (manually
or via Safe UI), gives MPT the address, MPT just routes to it. Zero
custody by MPT, but more friction on setup.

### Who pays the on-chain gas

Two clean options:

- **MPT pays everything via Roles Modifier** — backend EOA's xDAI
  funds all forward TXes. Per-event Safe never needs xDAI. Refunds
  require the merchant to acquire their own xDAI separately, OR MPT
  offers a "refund relay" feature.
- **Per-Safe xDAI buffer** — each event Safe holds e.g. €0.50 worth
  of xDAI for its own future ops (refunds, withdrawals). Less elegant
  but fully self-contained.

Phase A defaults to option 1 (no merchant gas burden).

### Regulatory posture

Open question for legal counsel:

- **Monerium KYCs the buyer** (the SEPA sender) under their EMI
  licence. This is upstream of MPT.
- **MPT does NOT KYC the event Safe owner** in the current model.
  Is MPT now a "payment service" under Hanfa / EU MiCA? PayCek became
  the first MiCA CASP licensee in Croatia (2026-04-10) — that's the
  likely benchmark.
- Per-event Safes might naturally distribute regulatory burden if
  framed as "the buyer pays the organiser directly via on-chain
  rails, MPT is the deterministic routing infrastructure not the
  custodian." Needs lawyer sign-off.

### Counterparty risk if event organiser disappears

If the event Safe is 1-of-1 and the owner loses their key, funds are
locked. Mitigations:

- Default to 2-of-2 with MPT as the optional secondary signer (acts
  as recovery, never as custodian — MPT signs only on organiser's
  documented request with off-chain proof of identity). Optional opt-in.
- Educate merchants to use Safe Mobile + iCloud Keychain / Android
  Keystore for high-availability key storage.
- Offer Safe seed escrow service via reputable Croatian notary as a
  premium feature.

### Comparison to entrio.hr current model

Entrio currently routes payments through credit-card processors and
PayCek (for crypto). In their flow, **entrio holds funds in custody
until payout** (T+N days). With per-event Safe rail:

- entrio retains the ticketing UX (event catalogue, checkout flow,
  buyer accounts)
- MPT becomes the settlement layer for the crypto/SEPA path
  specifically — funds bypass entrio entirely, land directly in
  organiser's Safe
- entrio collects its fee via the EPC remittance encoding (e.g.
  organiser sets up Safe with Zodiac split module: 95% to organiser,
  5% to entrio's fee-collection Safe — enforced on-chain at receipt)

Tradeoff for entrio: less float (they lose the interest on held
funds) but lower counterparty risk and stronger pitch ("your payments
land directly in your wallet, we can't touch them"). Probably attractive
to event organisers who got burned by PSP holds.

## Open product questions (for later)

- **What's the minimum viable merchant onboarding flow?** Likely:
  - Step 1: email + Safe deployment in browser (factory endpoint)
  - Step 2: confirm Safe address by signing a test message
  - Step 3: receive API key for MPT outbound webhooks
  - Total time: ~5 min from zero to first checkout

- **How does MPT make money in this model?**
  - Per-forward fee in basis points (e.g. 0.3% of forwarded EUR,
    deducted from amount before forward)
  - Subscription fee per active event Safe (€5/mo)
  - Premium features (seed escrow, multi-sig recovery, fiat-off-ramp
    via Monerium redeem)
  - All three are non-exclusive

- **Multi-recipient splits** — current memo format only carries one
  target. Future extension: `mpt:split:0xA:60,0xB:40?sid=...` parsed
  by extended sid module. Out of scope until first customer needs it.

- **Refunds** — should MPT offer a one-click refund API (organiser
  triggers, backend signs via separate role permitting reverse
  transfer)? OR is refund organiser's responsibility from Safe Mobile?
  Lower friction = first, higher purity = second.

## References

- [reference-mpt-brand-and-routing-architecture](../../backend/safe-tx/PHASE-2-SAFE-API.md) — the multisig propose-and-sign layer that complements Phase 1 auto-forward
- [RISK-MITIGATIONS.md](../../backend/safe-tx/RISK-MITIGATIONS.md) — typo defences relevant to organiser Safe address handling
- [001-eure-forwarder-role-setup.EXECUTED.md](../../backend/safe-tx/001-eure-forwarder-role-setup.EXECUTED.md) — current on-chain role scoping (works unchanged for per-event Safe rail)
- [PayCek competitor analysis](../competitor-analysis/paycek-electrocoin.md) — the model this design improves upon
- Safe Protocol Kit docs: https://docs.safe.global/sdk/protocol-kit
- Zodiac modular extension docs: https://zodiac.wiki

## Triggers for implementing this

This vision moves from "documented" to "in flight" when one of:

- A real prospective customer (entrio.hr, a ticketing platform, a
  fundraising platform) signals interest in integrating
- MPT's own donation/payment use case grows beyond a single recipient
  wallet
- Phase 2 multisig propose-and-sign (see PHASE-2-SAFE-API.md) is
  shipped — the SDK foundations overlap heavily
- Hanfa or another regulator asks "what is your custody model" —
  per-event Safe is a strong answer

Until one of those triggers, this is a strategy artifact, not a
roadmap. The fact that MPT's current architecture already supports
the core flow means we can pivot fast if the trigger arrives.
