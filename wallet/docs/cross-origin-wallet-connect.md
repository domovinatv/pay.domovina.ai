# Cross-origin passkey-wallet connect — design, rationale & best practices

**Status:** adopted & shipped in `sdk.js` **v0.8.0** — DETERMINISTIC full-page
redirect connect (curated chooser on the wallet) + cached identity for instant
repeat connects + CSRF `dw_state`. We tried RoR-first in-page (v0.7.0) and dropped
it: a dApp page cannot filter the OS passkey picker, so an in-page discoverable
get() shows ALL (incl. stale) passkeys uncurated. The wallet — which has the
registry — owns that UX instead. RoR infra (`.well-known/webauthn`) remains as
foundation but is not used for the connect ceremony.
**Last researched:** 2026-06-09 (web research with citations, see Sources).
**Applies to:** the DOMOVINA Wallet SDK (`public/sdk.js`, `/embed`, `Landing.tsx`)
consumed by tenant dApps on other registrable domains (e.g. `pinka.io`).

## The problem

The DOMOVINA Wallet is a **passkey-based smart-contract (Safe/4337) wallet** served
from `wallet.domovina.ai`, with WebAuthn **RP ID = `domovina.ai`**. Tenant dApps live
on **different registrable domains** (e.g. `pinka.io`). A dApp needs the user to
"connect" — authenticate with their existing ecosystem passkey so the dApp can read
the wallet's address/owner (and later request signatures).

This is the same problem Coinbase Smart Wallet, Privy, Turnkey, etc. solve. It is
**not novel** — there is an industry-standard answer, and a set of well-documented
traps. This doc records what we learned and why we chose what we chose.

## TL;DR decision

1. **Never run the WebAuthn ceremony inside a cross-origin iframe.** It is
   documented-unreliable on three independent axes (below). We tried it (branded
   inline `/embed` sheet, then fullscreen-expand during the ceremony) and it failed
   exactly as the literature predicts — the password-manager chooser (LastPass)
   rendered clipped/undismissable.
2. **Run the ceremony first-party, on a top-level `wallet.domovina.ai` context.**
   Two standards-based transports do this: a **full-page redirect** (what we ship)
   or a **popup window**. Both are correct; redirect is the more robust default,
   especially on mobile/PWA.
3. **There is an even more seamless option we are eligible for: Related Origin
   Requests (RoR)** — because `domovina.ai` and `pinka.io` are operated by the same
   org. It runs the ceremony *in-page* on the dApp with no navigation. Recommended
   as a progressive enhancement on top of the redirect (see "Recommended evolution").

## Why NOT a cross-origin iframe (the trap we hit)

A passkey ceremony in a third-party iframe fails on three independent mechanisms,
and Safari doesn't support the cross-origin path at all:

- **Storage partitioning.** Chrome Storage Partitioning (default since Chrome 115),
  Safari ITP, and Firefox Dynamic State Partitioning key an embedded iframe's
  `localStorage`/IndexedDB by the **top-level** site. So the wallet iframe embedded
  in `pinka.io` sees an **empty, partitioned** store — not the passkey registry it
  wrote as a first party. `document.requestStorageAccess()` **does not help**: on
  WebKit/Firefox it grants *cookies only*, never `localStorage`. (Safari's partition
  is also ephemeral — cleared between launches.)
- **Credential-picker / extension overlays don't render reliably in iframes.**
  Password managers inject autofill UI into the page DOM anchored to the *containing*
  rect; in a constrained cross-origin iframe it gets clipped / stacked behind content
  / undismissable. 1Password refuses to offer autofill in cross-origin iframes at
  all; LastPass/Bitwarden gate behind a warning and can hide the menu. **This is the
  exact "I only see the top of the LastPass UI and can't close it" symptom we saw.**
- **User activation cannot be relayed in.** `navigator.credentials.get()` in an
  iframe needs *transient activation*. Activation propagates only **upward** to
  containing frames from the direct gesture — it does **not** transfer via
  `postMessage`. So "user clicks in pinka.io → postMessage into the wallet iframe →
  iframe calls get()" is rejected for lack of activation. The gesture must land
  *inside* the iframe.
- **Safari has no cross-origin `create()`** and does not expose `topOrigin` — so even
  registration and server-side context checks break.

The WebAuthn WG itself (w3c/webauthn #1347) concluded a **redirect or popup is no
worse** than the iframe + Storage-Access dance (and avoids the double prompt). web.dev
scopes iframe passkeys to a narrow same-company SSO/payment pattern — not "embed a
third-party wallet." **Abandoning the iframe was correct.**

## The two viable first-party transports

| Criterion | Full-page redirect (**shipped**) | Popup window |
|---|---|---|
| IETF BCP / vendor stance | ✅ Recommended default | ⚠️ "Only if you must" (Auth0) |
| WebAuthn context | ✅ Top-level, wallet origin | ✅ Top-level, wallet origin |
| dApp state preserved | ❌ App reloads | ✅ Opener stays alive |
| Mobile browser / installed PWA | ✅ Most robust | ❌ Becomes a tab / breaks in iOS PWA |
| Popup blockers | ✅ N/A | ❌ Blocked unless opened sync in the click |
| COOP / `window.opener` fragility | ✅ None | ❌ `same-origin` COOP nulls opener → silent fail |
| 3p-cookie / storage phaseout | ✅ Resilient | ⚠️ Degrading |
| Return channel | URL params (scrub on arrival) | `postMessage` (strict origin) |
| Main risks | open-redirect, CSRF/state, URL leakage | COOP, blockers, mobile, origin checks |

**Industry note:** for *passkey wallets specifically*, the **popup** is the dominant
choice — Coinbase Smart Wallet (keys.coinbase.com) and Privy's cross-app flow both
use a popup to the wallet origin + origin-checked `postMessage`, precisely to get a
clean top-level WebAuthn context. For *general auth*, the IETF BCP makes **redirect**
the default and treats popup as a reluctant fallback. We chose **redirect** because it
is the most robust across mobile/PWA and has no COOP/opener fragility; our connect is
"step 1" so the page-reload cost is minimal.

## What we ship (sdk.js v0.8.0)

`Domovina.connect()`:
1. **Returning** (`?dw_return=1`) → CSRF-check `dw_state` → cache identity + resolve.
2. **Cached** on this host (first-party `localStorage` `domovina_connected_v1`) →
   resolve instantly, no prompt. (After the first connect, no redirect ever again.)
3. **Else → deterministic full-page redirect** to
   `wallet.domovina.ai/?dw_connect=1&dw_state=…&dw_return=<hostUrl>`. The wallet runs
   the ceremony FIRST-PARTY and — crucially — presents a **curated chooser** it can
   control (known wallets from its local + backend registry; an explicit "Otvori
   postojeći" get() only when needed; create; legacy migration), then redirects back
   with `?dw_return=1&dw_state=…&dw_safe=&dw_signer=&dw_cred=`.

Why not an in-page RoR `get()` on the dApp (tried in v0.7.0, removed): **a discoverable
get() shows the OS picker with ALL passkeys for the RP and the RP cannot filter it** —
so on pinka.io it surfaced stale/test passkeys uncurated, with no way to hide them. The
wallet can curate (it has the registry); the dApp cannot. The cross-domain passkey is
still SHARED — same ecosystem wallet, just chosen on the wallet's page.

`Landing.tsx` returns the identity at every "wallet ready" exit (open known / open
existing / after create), echoing `dw_state` back, with an **exact-origin allowlist**
on `dw_return` (`*.domovina.ai`, `*.pinka.io`, localhost). The host SDK CSRF-checks
`dw_state` (single-use, sessionStorage) and **strips the params via
`history.replaceState`**. `Domovina.disconnect()` clears the cache (dApp surfaces
"Promijeni novčanik"). The `/embed` iframe is retained only for `send()`.

## Security hardening checklist (redirect-return handoff)

Done: ✅ exact-origin allowlist on `dw_return`; ✅ `replaceState` scrub of the return
params; ✅ HTTPS both ends; ✅ identity cached in first-party storage; ✅ **`state`/CSRF
token** (`dw_state`, ≥128-bit, single-use sessionStorage, echoed by the wallet,
host-verified before accepting the identity — shipped v0.7.0).

Optional further hardening (not done):
- [ ] **Move the return values to the URL fragment (`#…`)** instead of the query
  string (fragments aren't sent to servers and aren't in `Referer`). `dw_safe`/
  `dw_signer` are public addresses and `dw_cred` is a public credential-id, so leak
  risk is low — but fragment + `replaceState` scrub is the clean belt-and-suspenders.
- [ ] **Integrity-bind the returned identity** (stronger): the wallet signs
  `{dw_safe, dw_signer, dw_cred, dw_state, exp}` and the dApp verifies, with a short
  `exp` to limit replay/tamper. (CSRF `dw_state` already blocks the practical attack;
  this defends against a compromised return channel.)

If a popup variant is ever added: opener sets `Cross-Origin-Opener-Policy:
same-origin-allow-popups`; receiver checks `event.origin === 'https://wallet.domovina.ai'`
exactly; send with an exact `targetOrigin` (never `'*'`); open the popup synchronously
in the click (no `await` first); fall back to redirect on mobile/PWA/blocked.

## Related Origin Requests (RoR) — tried in-page (v0.7.0), then REMOVED for connect

We shipped RoR-in-page in v0.7.0 and removed it in v0.8.0. The fatal flaw for the
connect UX: **a dApp's discoverable `get()` triggers the OS picker listing ALL
passkeys for RP `domovina.ai`, and the RP cannot filter which ones show** (no
`allowCredentials` to narrow to — the dApp has no local registry; that's the point of
RoR). Result: stale/test passkeys appear uncurated on pinka.io with no way to hide
them, and `get()` never offers "create". The wallet, via its registry, CAN curate —
so connect goes there (deterministic redirect) instead. The RoR foundation below
stays valid (and could power a future curated in-page flow), but is NOT on the connect
path today. Reference (how it worked):

1. `https://domovina.ai/.well-known/webauthn` lists the tenant origins incl.
   `https://pinka.io` (served as JSON; browser counts **unique eTLD+1 labels**, max
   **5** — current list = 3 labels: `domovina`, `pinka`, `pinka-app`).
2. On the dApp, behind the branded "Poveži" button (host-page gesture → chooser
   renders correctly because it's **top-level, not an iframe**), the SDK calls
   `navigator.credentials.get({ publicKey: { rpId: 'domovina.ai', … } })`
   synchronously (no awaits before it — activation preserved via `preloadWallet()`).
   We try optimistically rather than gating on `getClientCapabilities().relatedOrigins`
   (awaiting it risks the activation; an unsupported browser rejects fast → redirect).
3. Resolve `credentialId` → wallet via the public registry (`mpt.domovina.ai`,
   CORS-open to `pinka.io`), cache in first-party storage, done. **Falls back to the
   full-page redirect** on any gap.

Browser support: Chrome/Edge **128+** (Aug 2024), Safari **18+** (Sep 2024), Firefox
**152** (May 2026). Pre-152 Firefox / old Safari → redirect fallback. A backend
verifier (when signing) must accept `origin = https://pinka.io` while requiring
`rpIdHash = SHA-256("domovina.ai")`.

> History: an early SDK did "RoR-first" but fired it on page-load with no branding,
> chained provider choosers, then dead-ended in the iframe. The shipped fix gates RoR
> behind the **branded button tap** and falls back to **redirect** (not iframe).
> First-run friction: a brand-new user with no ecosystem passkey sees the native
> chooser and must dismiss it before the redirect-to-create — acceptable and one-time
> (the cache + the cross-tenant passkey discovery cover everyone else).

## Sources

Cross-origin WebAuthn / RoR:
- W3C WebAuthn L3 (RP ID "registrable domain suffix"): https://www.w3.org/TR/webauthn-3/
- W3C RoR explainer (file format, fetch rules, 5-label limit): https://github.com/w3c/webauthn/blob/main/explainers/related-origin-requests.md
- web.dev — Allow passkey reuse with RoR: https://web.dev/articles/webauthn-related-origin-requests
- passkeys.dev — Related Origins: https://passkeys.dev/docs/advanced/related-origins/
- Chrome 129 passkey updates (RoR shipped 128/129): https://developer.chrome.com/blog/passkeys-updates-chrome-129
- Corbado — Related Origins (browser matrix, OIDC/SAML fallback): https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys
- Firefox 152 RoR: https://bugzilla.mozilla.org/show_bug.cgi?id=2010193

WebAuthn-in-iframe pitfalls:
- web.dev — Passkeys within iframes: https://web.dev/articles/webauthn-within-iframe
- Corbado — Passkeys & iframes (cross-origin create/topOrigin gaps): https://www.corbado.com/blog/iframe-passkeys-webauthn
- w3c/webauthn #1347 (redirect/popup ≈ iframe+StorageAccess, double-prompt): https://github.com/w3c/webauthn/issues/1347
- Chrome Storage Partitioning: https://privacysandbox.google.com/3pcd/storage-partitioning
- WebKit — Storage Access API (cookies only): https://webkit.org/blog/8124/introducing-storage-access-api/
- MDN — State Partitioning: https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/State_Partitioning
- Chrome — user activation (not relayed via postMessage): https://developer.chrome.com/blog/user-activation
- Jscrambler — password managers & cross-origin iframes: https://jscrambler.com/blog/auto-failling-password-managers
- The Hacker Blog — LastPass iframe overlay clipping/clickjacking: https://thehackerblog.com/stealing-lastpass-passwords-with-clickjacking/

Web3 cross-domain wallet architectures:
- Coinbase / Base Smart Wallet — Popup Tips (COOP): https://docs.base.org/smart-wallet/concepts/usage-details/popups
- Coinbase Smart Wallet passkeys: https://help.coinbase.com/en/wallet/getting-started/smart-wallet-passkeys
- Privy — wallet connector deep dive (cross-app popup): https://privy.io/blog/wallet-connector-deep-dive
- Turnkey — IframeStamper (non-WebAuthn key model): https://docs.turnkey.com/sdks/advanced/iframe-stamper
- Safe Apps SDK (inverted: wallet hosts the app): https://docs.safe.global/apps-sdk-overview
- WalletConnect specs (relay model): https://specs.walletconnect.com/2.0/specs/clients/sign/data-structures

Popup vs redirect vs iframe handoff (auth):
- IETF — OAuth 2.0 for Browser-Based Apps (redirect default; state §7.3; history leak §10.9.1.2): https://www.ietf.org/archive/id/draft-ietf-oauth-browser-based-apps-13.html
- Auth0 — Redirect vs Popup ("only use popup if you must"): https://auth0.com/blog/getting-started-with-lock-episode-3-redirect-vs-popup-mode/
- OAuth.com — Redirect URI exact-match validation: https://www.oauth.com/oauth2-servers/redirect-uris/redirect-uri-validation/
- OWASP — Open Redirect: https://owasp.org/www-community/attacks/open_redirect
- MDN — postMessage (targetOrigin, never `*`): https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
- MDN — Cross-Origin-Opener-Policy: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy
- Firebase — signInWithRedirect best practices (iframe breaks under partitioning): https://firebase.google.com/docs/auth/web/redirect-best-practices
