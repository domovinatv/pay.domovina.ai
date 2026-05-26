# wallet-wasp eksperiment

**Datum**: 2026-05-26
**Status**: Faza 0 — scaffold pushed, plan locked
**Tracking repo**: [github.com/domovinatv/wallet-wasp](https://github.com/domovinatv/wallet-wasp)
**Lokalna lokacija**: `experiments/wallet-wasp/` (git submodule)

## TL;DR

Rewrite postojećeg `wallet.domovina.ai` (Vite/React + CF Workers, 9900 LOC frontend
+ 440 LOC backend) u [WASP](https://wasp.sh) (full-stack React + Node.js + Prisma
DSL framework) kao **standalone eksperiment + showcase za WASP community**. Cilj:
demonstrirati WASP-ove "40% manje tokena za istu app" tvrdnje na produkcijski-
validiranom passkey-Safe wallet use-case-u, repo dijeli s Matijom i Martinom
Šošićem (WASP founders) za potencijalnu blog/talk kolaboraciju.

Produkcijski `wallet.domovina.ai` ostaje netaknut — eksperiment je parallel
track, ne migracija.

## Goals

- Funkcionalni paritet s MVP-om (5 ključnih feature-a, niže) na live Gnosisu
- LOC + token-cost comparison s referentnom implementacijom
- Blog post + demo materijal za WASP community
- Bonus: WebAuthn auth provider kao PR u core WASP (ako bude čist)

## Non-goals

- Zamijeniti produkcijski wallet.domovina.ai
- Port iframe SDK ([[project_iframe_sdk_shipped]]) ili white-label sustava
  ([[project_white_label_shipped]]) u MVP — Faza 5+
- Phase 5 onchain attestation feature-i (ADR 0003–0006)
- Mobile/PWA polish za WASP verziju (samo desktop dev)

## Prerequirements — installed 2026-05-26

| Resurs | Verzija | Status |
|---|---|---|
| Node.js | 24.16.0 | Installed via nvm 2026-05-26 (WASP 0.23+ requires ≥24.14.1) |
| WASP CLI | 0.23.0 | Installed via npm 2026-05-26 (`@wasp.sh/wasp-cli@0.23.0` + `@wasp.sh/wasp-cli-darwin-arm64-unknown@0.23.0` — platform pkg eksplicitno radi workaround [upstream packaging bug](https://github.com/wasp-lang/wasp/issues) za darwin-arm64) |
| Claude Code | 2.1.150 | Pre-installed |
| Official WASP plugin | wasp@wasp-agent-plugins | Installed user-scope 2026-05-26 |
| GitHub repo | domovinatv/wallet-wasp | Public, created 2026-05-26 |
| Git submodule | experiments/wallet-wasp | Linked 2026-05-26, re-scaffold 0.23.0 commit `d5e2278` |

**Note**: WASP 0.21+ migrated install method from `curl ... installer.sh` na
npm. Migration helper: `curl -sSL https://get.wasp.sh/installer.sh | sh -s -- migrate-to-npm`.
Node 24 mora biti aktivan kad se zove `wasp` — `nvm use 24` ako default nije 24.

**Tailwind**: u 0.23.0 default scaffoldu **uklonjen** — opt-in feature preko
plugin `add-feature` skill-a. Naš referentni wallet koristi Tailwind intenzivno,
treba ga vratiti u Fazi 2.

**WASP plugin skills**: `add-feature`, `deploying-app`, `expert-advice`,
`start-dev-server`, `wasp-plugin-help`, `wasp-plugin-init`. Plugin obezbjeđuje
version-matched docs fetching za WASP DSL (otklanja hallucination zastarjelog
syntaxa). **Plugin NEMA passkey/WebAuthn skill** — to je risk za naš use-case.

**Sljedeći ručni korak (user)**: u `experiments/wallet-wasp/` pokrenuti
`/wasp-plugin-init` da injecta WASP-specific pravila u submodule-ov CLAUDE.md.
Claude Code mora biti restartan da skill-ovi plugin-a postanu vidljivi sesiji.

## Source-of-truth: trenutni wallet (zamrznuta spec)

```
wallet/
├── src/                       (~9900 LOC, ~62 fajla)
│   ├── routes/                12 stranica — Wallet, Send, Receive, Link,
│   │                          Activity, Settings, BindPhone, ExpandAccess,
│   │                          Landing, Embed, LinkCallback, UiPreview
│   ├── lib/                   20 modula — passkey, safe, safeOwners,
│   │                          webauthnSig, relay, paymentIntent, eip681,
│   │                          linking, recipients, balances, otp, registry,
│   │                          activity, theme, ...
│   ├── ui/                    11 shared UI komponenti
│   ├── components/            10 komponenti
│   ├── brands/                White-label data (default/sportklub/zupa)
│   ├── state/                 Zustand store
│   ├── app/                   App shell + routing (wouter)
│   └── styles/
├── functions/                 (~440 LOC) — CF Pages Functions
│   └── api/
│       ├── relay.ts           Gas-sponsorship relayer
│       └── relay/status.ts    Relayer health/status
└── public/
```

**Ključni externals**: `viem 2.50`, `@safe-global/protocol-kit 7.1`,
`@safe-global/safe-passkey 0.2`, `wouter`, `zustand`, `@radix-ui/*`,
`qr-code-styling`, `qr-scanner`, `tailwind`.

## Architecture mapping: CF → WASP

| Trenutno (CF/Vite) | WASP idiom | Notes |
|---|---|---|
| Vite + React 18 | WASP-managed React | WASP koristi Vite interno; zadržati React 18 |
| `wouter` routing | WASP `route`/`page` DSL | Re-write `src/routes/*` kao WASP page entries u `main.wasp` |
| Zustand store | Zustand (kompatibilno) | WASP ne diktira state lib; copy-paste |
| viem + Safe SDK | Identično (klijentski) | Bez izmjena — sve ostaje na client-u |
| CF Pages Function `relay.ts` | WASP `action sponsorTransaction` | Node.js viem signer; identična logika |
| CF Pages Function `relay/status.ts` | WASP `query relayStatus` | Trivial |
| `_headers` CSP/cache pravila | WASP server middleware + Vite config | Treba ručni port |
| Cloudflare Pages deploy | Fly.io ili Railway (WASP first-class) | **Gubitak edge locality** |
| Bez DB (sve client-side) | Prisma + Postgres (`User`, `Passkey`, `PeerLink`, ...) | Dodajemo persistence layer koji trenutno NE postoji |
| White-label preko `VITE_BRAND` | Env vars u WASP (Faza 5+) | Ne u MVP-u |

## MVP scope (Faza 2–4)

5 feature-a, mora raditi end-to-end protiv stvarne Gnosis mainnet transakcije:

1. **Passkey registration** — kreiraj WebAuthn credential, derive Safe address,
   spremi `(credentialId, pubkey, safeAddr)` u Prisma `Passkey` table
2. **Passkey login** — WebAuthn assertion → server-side ERC-1271 verify →
   WASP session
3. **Wallet view** — EURe balance od Gnosis RPC-a, recent activity
4. **Send EURe** — passkey sign → MultiSend (deploy-if-needed + transfer) →
   relayer action
5. **Receive intent** — generate EIP-681 QR; čita postojeću `pay.domovina.ai`
   payment intent rail bez backend izmjena ([[project_payment_intent_arbitrary_destination]])

**Eksplicitno IZVAN MVP-a**: peer linking, multi-passkey Safe, iframe SDK,
white-label, phone binding, attestation, OTP, settings.

## Phased plan

### Faza 0 — Foundation (✅ done 2026-05-26)
- WASP CLI provjeren, plugin installed
- GitHub repo + submodule kreirani
- `wasp new -t basic` scaffold pushed
- Ovaj spec dokument

### Faza 1 — Auth (3–5 dana, **biggest risk**)
- Izbaciti default email auth iz `main.wasp`
- Implementirati custom passkey auth: 4 endpointa (register-options,
  register-verify, auth-options, auth-verify) kao WASP actions
- Prisma model: `User`, `Passkey { credentialId, pubkey, safeAddr }`
- WASP session integration (custom session middleware ili WASP-ovo)
- **Decision point**: ako WASP-ova auth abstrakcija ne dopušta custom flow
  bez horror hackeva, escalate na WASP Discord / Matiju direktno —
  to je legitiman core-WASP gap koji bismo prijavili

### Faza 2 — Frontend port (3–5 dana)
- Copy `src/ui`, `src/components` 1:1 (čisti React)
- Convert `src/routes/Wallet.tsx`, `Send.tsx`, `Receive.tsx` u WASP pages
- Zamijeniti `fetch('/api/relay', ...)` s WASP `useAction(sponsorTransaction)`
- Zadržati viem + Safe SDK + zustand 1:1

### Faza 3 — Backend port (2–3 dana)
- `relay.ts` → WASP `action sponsorTransaction` (viem signer iz env)
- `relay/status.ts` → WASP `query relayStatus`
- Monerium webhook **NE PORTAMO** — to ostaje na pay.domovina.ai backendu
  (ovaj eksperiment je samo wallet, ne payment receiver)

### Faza 4 — Deploy + parity test (1–2 dana)
- Deploy na Fly.io kao `wallet-wasp.fly.dev`
- Stvarna Gnosis transakcija end-to-end (paritet s
  [[project_wallet_send_validated]])
- LOC + token-cost benchmark vs. produkcijski wallet

### Faza 5+ — Showcase (paralelno s 4)
- Blog post draft: "Rewriting a production passkey-Safe wallet in WASP"
- LinkedIn/Twitter sažetak Matiji + Martinu Šošiću
- Ako WebAuthn auth bude čist, otvori PR ili RFC issue u
  github.com/wasp-lang/wasp za first-class passkey auth method

## Key risks

| Risk | Vjerojatnost | Impact | Mitigation |
|---|---|---|---|
| WASP-ova auth ne dopušta custom passkey flow | Srednja | Visok | Faza 1 decision point — eskaliraj na WASP Discord; ako gating, dokumentiraj kao otvoreni issue i build na osnovi |
| WASP plugin docs out of sync sa stvarnim DSL-om | Niska | Srednji | Plugin tvrdi version-matched fetching; ako ipak — fallback na wasp.sh docs |
| Fly.io / Railway deploy overhead | Niska | Nizak | WASP plugin ima `deploying-app` skill; standardni put |
| LOC ispadne **veći** od referente (anti-WASP-claim) | Niska | Marketing | Bilo bi i to zanimljiv rezultat; honest report > marketing spin |
| ERC-1271 server verify kompliciran s Node viem | Niska | Srednji | Već riješeno u referentnoj implementaciji — copy-paste logiku |
| Phase 5 attestation feature-i će tražiti port | n/a | n/a | Eksplicitno izvan scope-a; future work |

## Open questions

- [ ] Podržava li WASP custom session middleware za non-email auth, ili moramo zaobići WASP auth potpuno?
- [ ] Postoji li već community WASP passkey auth provider u marketplace-u? (Provjera nakon Faza 1 starta)
- [ ] Cijena Fly.io hosting-a (vs. besplatni CF Pages za produkcijski) — relevantno za showcase priču
- [ ] Token-cost mjerenje metodologija — koristiti WASP-ov "tokens per feature" framework iz njihovog blog posta?
- [ ] White-label u WASP-u — env-driven build kao trenutno, ili runtime tenant detection?

## Showcase strategija

- **Cilj**: Matija + Martin Šošić repostaju eksperiment, WASP community vidi
  realnu produkcijski-validiranu app rewritten u WASP
- **Asset**: javni repo + blog post + (možda) talk za WASP community calls
- **Hooks za WASP marketing tim**:
  - "First WASP app s passkey + ERC-4337 Safe na mainnetu"
  - "Powered by domovina.ai" footer + brand
  - Token-cost number (target: ≤60% referentne implementacije, paritet s
    WASP-ovom "40% manje" tvrdnjom)
- **Risk**: ako WASP auth gating prijeti scope-u, ipak isporučiti čak i s
  custom-bypass auth-om, ali jasno označiti to kao "WASP-tooling gap" u
  blog postu — to je vrijednija priča za WASP tim nego silent skip

## References

- Production wallet: `wallet/` u ovom repu, [wallet.domovina.ai](https://wallet.domovina.ai)
- WASP plugin: [github.com/wasp-lang/claude-plugins/tree/main/plugins/wasp](https://github.com/wasp-lang/claude-plugins/tree/main/plugins/wasp)
- WASP "40% less tokens" claim: [wasp.sh/blog/2026/03/26](https://wasp.sh/blog/2026/03/26/nextjs-vs-wasp-40-percent-less-tokens-same-app)
- WASP Claude Code essentials: [wasp.sh/blog/2026/01/29](https://wasp.sh/blog/2026/01/29/claude-code-fullstack-development-essentials)
- Cross-domain wallet plan (related, broader scope): `docs/plans/cross-domain-wallet-passkey.md`
