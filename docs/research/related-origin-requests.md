# Research — WebAuthn Related Origin Requests (RoR)

**Status:** Research note (not an ADR).
**Date:** 2026-06-02.
**Author:** Claude Code research pass for Matija Stepanic, ITalk d.o.o.
**Scope:** Cross-domain passkey reuse for the DOMOVINA wallet ecosystem
(`*.domovina.ai` + third-party TLDs such as `pinka.io`).

> This is a factual research note. Every external claim below carries a
> source URL. It does **not** supersede the existing plan/ADRs — it feeds
> them. See section 6 for pointers.

---

## 1. What RoR is

**Related Origin Requests (RoR)** is the W3C WebAuthn Level 3 mechanism that
lets a passkey created under one **Relying Party ID (RP ID)** be used from a
set of *other* web origins that the RP explicitly allowlists — without
iframes, without a wallet SDK, using the native `navigator.credentials`
API directly on the third-party site.

The mechanism, in one paragraph: a passkey is permanently bound to a single
RP ID at creation time (no rename API). Normally the browser only surfaces
that passkey to pages whose origin matches the RP ID (or a stricter
subdomain). RoR relaxes that: when a site calls
`navigator.credentials.get/create` with an RP ID that does **not** match the
calling origin, a RoR-capable browser fetches
`https://{RP ID}/.well-known/webauthn`, reads an allowlist of origins, and —
if the calling origin is on the list — lets the request proceed with the
original RP ID.
([web.dev](https://web.dev/articles/webauthn-related-origin-requests),
[W3C explainer](https://github.com/w3c/webauthn/wiki/Explainer:-Related-origin-requests))

Why this matters for us: the on-chain `SafeWebAuthn` signer does **not**
enforce RP ID — it verifies a P-256 signature against the stored pubkey and
ignores which origin produced the assertion. The browser is the only RP-ID
gatekeeper. RoR is therefore exactly the standards-track way to convince the
browser to surface one DOMOVINA passkey to e.g. `pinka.io` natively. (See
`docs/plans/cross-domain-wallet-passkey.md` for the full reasoning.)

**Phishing note:** RoR does **not** weaken phishing protection. Phishing
resistance comes from the browser binding the assertion to the *actual*
calling origin in the `CollectedClientData` field, which the RP verifies on
the server/verifier side — not from RP-ID isolation alone.
([web.dev](https://web.dev/articles/webauthn-related-origin-requests))

---

## 2. How our `/.well-known/webauthn` is wired

The DOMOVINA RP ID for the cross-domain (parent-domain) passkeys is
`domovina.ai` (see Phase B in the cross-domain plan). RoR therefore requires
the file to be served at:

```
https://domovina.ai/.well-known/webauthn
```

served **live from `domovina.ai`** (the RP-ID apex, not a subdomain), with
**`Content-Type: application/json`**, containing a single JSON object whose
`origins` key is an array of allowlisted web origins:

```json
{
  "origins": [
    "https://pinka.io",
    "https://wallet.domovina.ai"
  ]
}
```

When a passkey created under RP ID `domovina.ai` is requested from
`https://pinka.io`, a RoR-capable browser fetches the file above, confirms
`https://pinka.io` is listed, and surfaces the passkey natively on
`pinka.io`. ([web.dev](https://web.dev/articles/webauthn-related-origin-requests),
[passkeys.dev](https://passkeys.dev/docs/advanced/related-origins/))

Format rules to respect:
- Exact path `/.well-known/webauthn` — **no `.json` extension.**
- Must be `Content-Type: application/json`.
- `origins` is an array of full origins (scheme + host), one per partner.
- The apex that serves the file = the RP ID = the value passed as
  `publicKey.rp.id` (and `rpId` on `.get()`). This is `domovina.ai`, so the
  file lives at the apex, not at `wallet.domovina.ai`.

> **Repo status as of 2026-06-02:** no committed `.well-known/webauthn` file
> exists in this repo yet (searched `wallet/public/`, `_headers`, whole
> tree). RoR is Phase D in the plan — "not yet built." When it ships, the
> file is hosted on the `domovina.ai` apex CF Pages project, **not** the
> wallet subdomain. The wallet's existing `_headers` only configures the
> iframe `/embed` route, not a well-known file.

---

## 3. Browser support (as of 2026-06-02)

| Engine | First version with RoR | Release | Platforms | Source |
|---|---|---|---|---|
| Chrome / Edge (Chromium) | **128+** | Aug 2024 | Android, ChromeOS, macOS, Windows, Linux | [Corbado](https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys), [Levi Schuck](https://levischuck.com/blog/2024-07-related-origins) |
| Safari / WebKit | **18+** (requires macOS 15 / iOS 18) | Sept 2024 | macOS 15+, iOS 18+, iPadOS 18+ | [Corbado](https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys) |
| Firefox | **152+** | May 2026 | Desktop + Android | [Corbado](https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys), [web.dev (was "considering" Jan 2026)](https://web.dev/articles/webauthn-related-origin-requests) |

### The headline conclusion for the team

**Safari/iOS users ARE covered, as long as they are on iOS 18+ / macOS 15+.**
RoR shipped in Safari 18 (Sept 2024). Because iOS forces every browser
(Chrome, Firefox, etc. on iPhone/iPad) onto the WebKit engine, RoR works in
**all iOS browsers on iOS 18+**, not just Safari.
([Corbado](https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys))

Caveats:
- **iOS < 18 / macOS < 15 has NO RoR support** — those users need the
  iframe-bridge fallback (ADR 0009). This is the single residual gap as of
  mid-2026; it shrinks as iOS 18 adoption climbs.
- **Firefox** only gained RoR in **152 (May 2026)** — recent. Users on older
  Firefox need the fallback. On Android, Firefox shows a dedicated permission
  prompt for related-origin requests (a privacy safeguard, not a failure).
  ([Corbado](https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys))
- For exact, continuously-updated support, consult the passkeys.dev device
  matrix (`#ror` anchor):
  [passkeys.dev/device-support](https://passkeys.dev/device-support).

**Bottom line:** RoR is broadly viable in 2026 across all three major
engines. The iframe SDK is still required as a fallback purely for the
pre-iOS-18 / pre-macOS-15 / pre-Firefox-152 long tail.

---

## 4. The eTLD+1 / label cap

There is a **hard cap of 5 distinct labels** in the `origins` list.

- The WebAuthn Level 3 spec **requires** clients to support a minimum of
  **5 unique labels**; **no known browser supports more than 5**, so treat
  **5 as the effective maximum** for deployments.
  ([passkeys.dev](https://passkeys.dev/docs/advanced/related-origins/),
  [web.dev](https://web.dev/articles/webauthn-related-origin-requests))
- A **label** is the registrable name immediately preceding the public
  suffix (the eTLD+1 label). E.g. `shopping` is the label shared by
  `shopping.com`, `shopping.co.uk`, `shopping.co.jp`, `shopping.net`, and
  `shopping.org`. ([web.dev](https://web.dev/articles/webauthn-related-origin-requests))
- The counting is **per label, not per origin**: if all 30 entries share the
  same label, they count as **1**. So a brand with many ccTLDs of the same
  name is cheap; many *distinct* partner brands are what burns the budget.
  ([web.dev](https://web.dev/articles/webauthn-related-origin-requests))
- If the list exceeds 5 labels, **the excess entries are silently ignored**
  by the browser (not an error).
  ([web.dev](https://web.dev/articles/webauthn-related-origin-requests))

**Implication for DOMOVINA:** all `*.domovina.ai` origins collapse to a
single label (`domovina`) and are also covered natively by the parent-domain
RP ID (Phase B) without needing a well-known entry at all. The 5-label budget
is therefore spent on **distinct third-party brand TLDs** —
`pinka` (`pinka.io`/`pinka.finance` share the `pinka` label) plus up to ~4
more distinct partner brands. Beyond that, partners must either use the
iframe SDK or be onboarded as their own RP via the ADR 0008 peer-linking
path.

---

## 5. RoR vs the iframe-bridge approach

Both solve "use one DOMOVINA passkey + Safe from a non-`domovina.ai` TLD."
They are complementary, not mutually exclusive.

| Dimension | Related Origin Requests | Iframe bridge (ADR 0009 SDK) |
|---|---|---|
| Integration on partner site | Native `navigator.credentials` call with our RP ID; no iframe | `<script src=".../sdk.js">` injects hidden `wallet.domovina.ai/embed` iframe; postMessage protocol |
| Where WebAuthn runs | On the partner origin directly | Inside our origin (the iframe) |
| Browser coverage | Chrome/Edge 128+, Safari 18 (iOS 18/macOS 15), Firefox 152+ | Every browser, today |
| **Safari ITP / storage friction** | **None** — no third-party storage involved; native prompt | **Yes** — third-party iframe localStorage is partitioned; needs `document.requestStorageAccess()` one-tap consent per session ([ADR 0009](../decisions/0009-iframe-sdk-third-party-embedding.md)) |
| Permissions-Policy plumbing | None on partner side | Requires `publickey-credentials-get/create` delegation + `frame-ancestors *` on `/embed` |
| Partner count limit | **Hard 5-label cap** (browser) | Unlimited |
| UX feel | Pure native OS passkey sheet, no extra surface | In-iframe modal confirm card + (Safari) a storage-access prompt |
| Maintenance | One static JSON file on `domovina.ai` apex | A versioned postMessage protocol + embed shell to maintain |
| Self-custody invariant | Preserved (browser is gatekeeper; signer never sees RP ID) | Preserved (iframe = our origin, never crosses key material) |

### Why the iframe bridge has friction RoR avoids

The iframe runs as a **third-party context** on the partner's page. Safari's
ITP (and Chrome's storage partitioning) wall off that iframe's `localStorage`
from the first-party copy on `wallet.domovina.ai`, so the user's wallet is
invisible inside the iframe until they grant access via the **Storage Access
API** (`document.requestStorageAccess()`), which needs a user gesture and, on
Safari, shows a "Allow … to use cookies?" prompt. That is one unavoidable
extra click on every fresh third-party embedding.
([ADR 0009](../decisions/0009-iframe-sdk-third-party-embedding.md),
[Storage Access API](https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API))

RoR has **no storage-access step at all** — it does not rely on iframe
storage. The browser surfaces the passkey through the native OS sheet on the
partner origin. That is the core UX win, and the main reason RoR is the
target end-state for the handful of high-value partner TLDs.

### Recommended posture (consistent with the existing plan)

1. **Parent-domain RP ID (`domovina.ai`)** covers all first-party
   `*.domovina.ai` apps natively — no RoR file, no iframe needed.
2. **RoR** for the small set (≤5 labels) of strategic third-party partner
   brands (`pinka`, …) once we accept the iOS-18+/Firefox-152+ floor.
3. **Iframe SDK** remains the universal fallback for: pre-iOS-18 users,
   pre-Firefox-152 users, partner #6+, and anyone we have not added to the
   well-known allowlist.

---

## 6. Pointers to existing plans / ADRs (do not duplicate)

- **`docs/plans/cross-domain-wallet-passkey.md`** — the master plan.
  - Option 1 = parent-domain RP ID; Option 2 = RoR (WebAuthn L3);
    Option 3 = iframe SDK. Recommendation is hybrid 1 + 3 today, RoR later.
  - **Phase B** = parent-domain RP ID for `*.domovina.ai`.
  - **Phase D** = "Related Origin Requests (2027+, gated on iOS Safari
    support)" — **this research updates that gating assumption:** Safari 18
    shipped RoR in Sept 2024, so the iOS-Safari blocker the plan cited is now
    largely cleared for iOS 18+ devices. Phase D can move earlier than the
    "2027+" the plan tentatively set.
- **`docs/decisions/0009-iframe-sdk-third-party-embedding.md`** (ADR 0009) —
  the shipped iframe SDK (`wallet.domovina.ai/sdk.js` + `/embed`), Storage
  Access API handling, Permissions-Policy/CSP headers. This is the fallback
  RoR complements, not replaces.
- **`docs/decisions/0008-multi-passkey-same-safe.md`** (ADR 0008) — the
  *other* third-party model: peer brand gets its **own** RP + its own
  enrolled passkey added as a Safe co-owner. Orthogonal to RoR (which reuses
  the *same* passkey across origins rather than minting a new owner).
- **`docs/decisions/0001-no-server-side-recovery.md`** (ADR 0001) — the
  self-custody invariant RoR preserves (browser-gated, signer never sees
  RP ID).

---

## Sources

- web.dev — *Allow passkey reuse across your sites with Related Origin
  Requests*:
  https://web.dev/articles/webauthn-related-origin-requests
- passkeys.dev — *Related Origin Requests*:
  https://passkeys.dev/docs/advanced/related-origins/
- passkeys.dev — device support matrix (`#ror`):
  https://passkeys.dev/device-support
- W3C WebAuthn wiki — *Explainer: Related origin requests*:
  https://github.com/w3c/webauthn/wiki/Explainer:-Related-origin-requests
- W3C WebAuthn Level 3 spec — Related Origins section:
  https://w3c.github.io/webauthn/#sctn-related-origins
- Corbado — *WebAuthn Related Origins (ROR): Cross-Domain Passkey Guide*
  (version/date table):
  https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys
- Levi Schuck — *Coming soon to Chrome and Safari: WebAuthn related origins*
  (Chromium Aug 2024):
  https://levischuck.com/blog/2024-07-related-origins
- MDN — Storage Access API:
  https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API
