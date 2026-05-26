# ADR 0009 — Iframe SDK for third-party dApp wallet embedding

**Status:** Accepted, MVP implemented (PR #36). Backfilled documentation.
**Date:** 2026-05-26 (decision date; MVP implementation landed earlier).
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Inherits from:** ADR 0001 (self-custody — embedded dApps never see user secrets).

## Context

Third-party dApps in the Croatian / regional ecosystem (NGO donation
pages, community marketplaces, ticket sellers, sports clubs without
their own white-labeled tenant from ADR 0007) want EURe payment
capability without:
1. Hosting their own wallet codebase
2. Running WebAuthn enrollment flows on their domain
3. Holding user passkeys or signing material

This is structurally distinct from the multi-passkey model of ADR
0008. In ADR 0008, the third-party site IS a peer brand (it has its
own RP, its own enrolled passkey, becomes a Safe co-owner). Here, the
third-party site is just a CONSUMER of an existing wallet — the user
keeps all their material on `wallet.domovina.ai` and the dApp gets
read access + an "open the wallet to confirm this tx" pattern.

The mature pattern for this in the broader Ethereum ecosystem is
**WalletConnect** (relay-based, QR / deep-link bootstrap). It works
across any combination of wallet ↔ dApp on any TLD, but adds friction:
user leaves the dApp's tab, opens their wallet app, scans / clicks,
returns. For lightweight in-page integrations (e.g. donate button on
a content site) this is more friction than the audience tolerates.

The alternative — direct iframe embedding — collapses the UX:
1. dApp drops `<iframe src="https://wallet.domovina.ai/embed">`
2. iframe runs under our origin → has native access to user's
   passkey + Safe registry (no Storage Access prompts because
   first-party storage for THIS iframe's origin)
3. dApp and iframe communicate via postMessage with a typed
   protocol
4. User confirms each operation with Face ID inside the iframe

Trade-off: this only works for users who already have a wallet on
`wallet.domovina.ai`. Users without one see an inline onboarding
prompt with a deep link out to wallet.domovina.ai for creation.

## Decision

### Decision 1 — Iframe SDK serves dApps that don't want to white-label

A standalone JavaScript SDK at `wallet.domovina.ai/sdk.js` (raw,
unbundled, ~120 lines) exposes a `window.Domovina` global with
Promise-based methods:

```js
const wallet = await Domovina.connect();
// → { safeAddress, signerAddress, balance }
const tx = await Domovina.send({ to: '0x…', amount: '1.07' });
// → { txHash } after user Face ID confirmation inside iframe
```

The SDK injects a hidden iframe pointing at
`wallet.domovina.ai/embed`, sets up postMessage handlers, and resolves
the promises when the iframe reports operation completion.

### Decision 2 — `/embed` route is the iframe-mode wallet shell

A separate route `wallet/src/routes/Embed.tsx` renders a thin
iframe-mode UI:
- Reads the user's existing wallet from `localStorage` (works
  because the iframe runs under the wallet.domovina.ai origin —
  first-party storage access).
- Listens for commands via postMessage from the parent dApp.
- For each command requiring user consent (send, signMessage),
  renders an in-iframe confirm card with explicit details. User
  must press a button → Face ID → tx submitted via existing relay.
- postMessages result back to parent (success / error / cancelled).

### Decision 3 — Storage Access API for Safari ITP compatibility

Safari ITP partitions third-party iframe localStorage by default,
making the user's existing wallet invisible from inside the iframe.
The fix is `document.requestStorageAccess()` invoked at user gesture
(a button click in the iframe). Embed.tsx calls this once per command
session before any operation that needs storage access.

User experience on Safari: a one-time "Allow wallet.domovina.ai to
access cookies?" prompt the first time they invoke a wallet operation
from a third-party dApp embedding. Survives within the iframe session.

### Decision 4 — Permission-policy delegation on `/embed`

`wallet/public/_headers` for `/embed`:
```
Permissions-Policy: publickey-credentials-get=*, publickey-credentials-create=*
Content-Security-Policy: frame-ancestors *
```

`publickey-credentials-*` delegation is REQUIRED for WebAuthn to
function inside a third-party iframe (Chrome/Edge/Firefox enforce
this; Safari implicitly allows). `frame-ancestors *` allows any TLD
to embed; combined with the explicit per-command user gesture and
postMessage origin validation, the surface is contained.

### Decision 5 — SDK is delegated, not custodial

The SDK never receives the user's signing material. All cryptographic
operations happen inside the iframe (running on
`wallet.domovina.ai`), using the user's passkey via WebAuthn. The
dApp's JS context cannot read the user's passkey, the Safe's private
state, or any intermediate signing values. The SDK's purpose is
**orchestration** (request → user consents → result), not custody.

This preserves ADR 0001's self-custody invariant for embedded dApps
the same way the standalone wallet does — the user's material never
crosses an origin boundary.

### Decision 6 — Onboarding fallback for users without a wallet

If `Domovina.connect()` is called and no wallet exists at
`wallet.domovina.ai` (fresh user), the iframe renders a CTA pointing
out to `wallet.domovina.ai/` for wallet creation, then comes back to
the dApp once the user has enrolled.

(Initial MVP implementation: shows a simple "Create wallet on
wallet.domovina.ai first" message with a deep link. Polished
onboarding-in-iframe is future work.)

## Consequences

### Positive

1. **Drop-in EURe payment capability for any Croatian dApp.** Two
   lines of HTML: `<script src="https://wallet.domovina.ai/sdk.js">`
   + an event handler calling `Domovina.send`.
2. **No regulatory burden transferred to the dApp.** The wallet
   relationship + GDPR data handling stays with us; the dApp is a
   pure consumer.
3. **No user-side onboarding for dApps.** Existing wallet users skip
   directly to "confirm payment" without re-enrolling per site.
4. **Self-custody invariant intact.** Iframe origin = our origin =
   first-party WebAuthn + Safe interaction; dApp never touches
   passkey material.

### Negative

1. **Two integration models exist** (ADR 0008 peer linking vs ADR
   0009 iframe SDK), and choosing between them is non-obvious for a
   would-be partner. Documentation must clarify: tenant white-label
   (their own brand, their own RP, peer-linkable Safe) vs SDK
   consumer (no brand, no enrollment, drop-in payment).
2. **Safari `requestStorageAccess` prompt is friction.** One extra
   click for first-time Safari users on any new third-party dApp
   embedding. Cannot be avoided structurally.
3. **Onboarding-in-iframe is incomplete.** Users without a wallet
   get a deep-link out, not an in-place flow. UX wart but not
   blocker.
4. **Iframe SDK surface needs version discipline.** `sdk.js` is
   served with short cache (5 min in `_headers`) to allow fast
   iteration, but breaking the postMessage protocol is a hard
   change once external dApps depend on it. Semver-style versioning
   in future updates.

### Neutral

1. **Permissions-Policy + frame-ancestors:* the same as ADR 0008
   `/link` page.** Both have the same threat model and the same
   mitigations.
2. **The SDK does not duplicate ADR 0008 peer linking.** They serve
   different audiences and CAN coexist (a dApp could use the SDK
   for one-off payments AND offer a white-label option for power
   users who want their own brand).
3. **Demo / docs surface** `wallet/public/sdk-demo.html` ships
   alongside `sdk.js` so integrators can verify the integration
   without our docs site.

## Implementation tracking

| Component | Status | PR |
|---|---|---|
| D1: `public/sdk.js` raw SDK loader + `Domovina` global | ✅ Shipped (MVP) | #36 |
| D1: Promise-based `connect()` + `send()` API | ✅ Shipped (MVP) | #36 |
| D2: `routes/Embed.tsx` iframe-mode shell | ✅ Shipped (MVP) | #36 |
| D2: In-iframe confirm card per command | ✅ Shipped | #36 |
| D3: Storage Access API call at user gesture | ✅ Shipped | #36 |
| D4: CSP + Permissions-Policy headers on `/embed` | ✅ Shipped | #36 |
| D5: Delegated-not-custodial pattern | ✅ Shipped | #36 (architectural; nothing to add) |
| D6: Onboarding deep-link for users without wallet | ✅ Shipped (basic) | #36 |
| **Future**: `signMessage` command (arbitrary EIP-712 signing) | ⏳ Not started | Common request from dApps |
| **Future**: `getAddress` without prompting for connect | ⏳ Not started | Reduce prompts for read-only dApps |
| **Future**: In-iframe onboarding for fresh users | ⏳ Not started | Replace deep-link fallback |
| **Future**: postMessage protocol semver | ⏳ Not started | First external partner integration triggers this |
| Demo page `/sdk-demo.html` | ✅ Shipped | #36 |

## References

- WalletConnect protocol (the rejected alternative for in-page
  flows): https://docs.walletconnect.com/
- WebAuthn third-party iframe support:
  https://chromestatus.com/feature/5765488464527360
- Storage Access API:
  https://privacycg.github.io/storage-access/
- ADR 0001 — self-custody (preserved by delegation pattern).
- ADR 0008 — peer linking (the *other* third-party integration path).
- Memory: `[[reference-wallet-domovina]]`.
