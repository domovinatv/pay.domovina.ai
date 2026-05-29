# DOMOVINA Wallet — Blog Sourcebook / Sadržajni SSOT

> **Što je ovo / What this is.** Jedinstveni izvor istine (*single source
> of truth*) za **sav vanjski sadržaj** o `wallet.domovina.ai` — blogovi,
> društvene mreže, press, grant prijave, README hero copy. Tehnički SSOT
> ostaje [`wallet/README.md`](../../wallet/README.md) i ADR-ovi u
> [`docs/decisions/`](../decisions/INDEX.md); **ovaj dokument ne duplicira
> arhitekturu nego je pretvara u činjenice i priču spremne za objavu.**
>
> **Single source of truth** for all *outbound content* about
> `wallet.domovina.ai` — blog posts, social, press, grant copy, README
> hero text. The technical SSOT remains the wallet README and the ADRs;
> this doc turns architecture into publish-ready facts and narrative.

**Pravilo / The rule:** ako činjenica nije ovdje ili u povezanom ADR-u,
**ne tvrdi je u objavi.** Caveati u §11 su obavezni — ne preuveličavaj.
If a fact isn't here or in a linked ADR, don't claim it in published copy.
The caveats in §11 are binding — don't overstate.

**Jezik / Language:** dvojezično usporedno. Tablice imaju HR | EN stupce;
narativ ima parne **HR** / **EN** blokove. Kanal određuje jezik objave
(npr. WASP/open-source = EN, domovina.tv = HR).

**Per-publika verzije / Per-audience versions.** Ovo je master SSOT.
Svaka od 4 publike ima zaseban, labeliran brief (pitch, poruke, blogovi,
kanal, jezik, caveati) izveden iz ovog dokumenta. Ako se brief i SSOT
koso — **SSOT je glavni.** This is the master SSOT; each audience has a
standalone labeled brief derived from it — SSOT wins on conflict.

| Brief | Publika / Audience | Jezik / Lang | Kanali / Channels |
|---|---|---|---|
| [01](wallet-audience-briefs/01-hrvatska-publika.md) | Hrvatska šira publika | HR | domovina.tv, FB/IG, YouTube |
| [02](wallet-audience-briefs/02-developeri-web3.md) | Developers / Web3 | EN | dev.to, HN, X, Safe/Gnosis forums |
| [03](wallet-audience-briefs/03-wasp-open-source.md) | WASP / open-source | EN | WASP community, GitHub, X |
| [04](wallet-audience-briefs/04-regulatorni-fintech.md) | Regulatorni / fintech | HR + EN | LinkedIn, policy blog, grant/partner |

---

## Sadržaj / Contents

1. [Pitch (4 publike)](#1-pitch--the-pitch)
2. [Kanonske činjenice](#2-kanonske-činjenice--canonical-facts)
3. [Priča](#3-priča--the-story)
4. [Kako radi](#4-kako-radi--how-it-works)
5. [Po čemu se razlikuje](#5-po-čemu-se-razlikuje--differentiators)
6. [Roadmap (ADR-backed)](#6-roadmap)
7. [Dokazi](#7-dokazi--proof-points)
8. [Backlog blogova](#8-backlog-blogova--blog-post-backlog)
9. [Biblioteka screenshotova](#9-biblioteka-screenshotova--screenshot-library)
10. [Pojmovnik](#10-pojmovnik--glossary)
11. [Što NE tvrditi](#11-što-ne-tvrditi--honesty-guardrails)
12. [Izvori](#12-izvori--sources)

---

## 1. Pitch / The pitch

**One-liner**

| HR | EN |
|---|---|
| Self-custody EURe novčanik na Gnosis Chainu — šalji i primaj eure bez seed phrasea, s Face ID-em kao jedinom autentikacijom. | A self-custody EURe wallet on Gnosis Chain — send and receive euros with no seed phrase, Face ID as the only authentication. |

**Po publici / Per audience** (isti proizvod, drugi kut / same product, different angle)

| Publika / Audience | Hook (HR) | Hook (EN) |
|---|---|---|
| **Hrvatska šira publika** | Tvoj novac, tvoj telefon. Eure držiš sam, bez banke i bez papirića sa 12 riječi koje se gube. Napuniš ga običnim SEPA prijenosom. | Your money, your phone. Hold euros yourself — no bank, no 12-word paper to lose. Top it up with an ordinary SEPA transfer. |
| **Developeri / Web3** | Passkey-owned Safe smart account: WebAuthn P-256 signer, ERC-1271, counterfactual deploy, gas-sponsored relayer, drop-in iframe SDK. Bez custodija, bez seed-a. | A passkey-owned Safe smart account: WebAuthn P-256 signer, ERC-1271, counterfactual deploy, gas-sponsored relayer, drop-in iframe SDK. No custody, no seed. |
| **WASP / open-source** | `open-wallet` — analog `open-saas`-a za Web3. Self-hostaj vlastiti brandirani EURe novčanik; brand-as-data od prvog dana. | `open-wallet` — the `open-saas` analog for Web3. Self-host your own branded EURe wallet; brand-as-data from day one. |
| **Regulatorni / fintech** | MiCA-svjestan EMT (EURe/Monerium) + put prema sybil-otpornom, GDPR-usklađenom onchain identitetu kroz hrvatski eID (Certilia). | A MiCA-aware EMT (EURe/Monerium) plus a path to sybil-resistant, GDPR-compliant on-chain identity via Croatian eID (Certilia). |

---

## 2. Kanonske činjenice / Canonical facts

*Provjereno protiv README-a + ADR INDEX-a, 2026-05-29. Verified against
README + ADR INDEX.*

| Činjenica / Fact | Vrijednost / Value |
|---|---|
| Proizvod / Product | `wallet.domovina.ai` — self-custody EURe wallet (PWA) |
| Vlasnik / Owner | ITalk d.o.o. (Domovina obitelj proizvoda / family) — Matija Stepanić |
| Chain | Gnosis Chain (chainId **100**) |
| Token | **EURe** (Monerium e-money EMT) — `0xcB444e90D8198415266c6a2724b7900fb12FC56E` |
| Custody model | Self-custody. Passkey-owned **Safe** smart account. Bez seed phrasea / no seed phrase. |
| Autentikacija / Auth | WebAuthn passkey (Face ID / Touch ID); P-256 signer u Keychainu/1Password |
| Top-up | SEPA prijenos → Monerium → EURe na korisnikov Safe (preko `mpt.domovina.ai` payment-intent rail-a) |
| Slanje / Send | Safe `execTransaction` + passkey potpis → CF Worker relay → on-chain; **gas plaća app** |
| Besplatne tx / Free tx | **5 tx/dan po passkeyu** (KV brojač); relayer ~$10 xDAI ≈ ~15.000 tx |
| Recovery | Cross-device passkey (iCloud/Google sync) + backend registry fallback; **opcionalni** phone OTP binding. **Nema server-side recoveryja.** |
| Hosting | Cloudflare Pages (`wallet-domovina`) + Pages Functions za `/api/relay` |
| Tech stack | Vite 5 + React 18 + TS, Tailwind, wouter, viem, `@safe-global/protocol-kit` + `safe-passkey`, Zustand, `vite-plugin-pwa` |
| White-label | Brand-as-data; **3 tenanta live**: default (DOMOVINA), sportklub, zupa |
| SDK | Iframe SDK MVP (`/sdk.js` + `/embed`) za third-party dApp plaćanja |
| Status | **Live**; Send pipeline validiran na pravoj Gnosis tx **2026-05-22** |
| Invarijante / Invariants | No server-side recovery · no seed phrases · no cloud-held signing keys · no plaintext PII (ADR 0001) |

**Javne adrese / Public addresses (Gnosis):**

| | |
|---|---|
| `SafeWebAuthnSignerFactory` | `0x1d31F259eE307358a26dFb23EB365939E8641195` |
| `SafeWebAuthnSharedSigner` | `0x94a4F6affBd8975951142c3999aEAB7ecee555c2` |
| `DaimoP256Verifier` (fallback) | `0xc2b78104907F722DABAc4C69f826a522B2754De4` |
| `EURe` | `0xcB444e90D8198415266c6a2724b7900fb12FC56E` |

---

## 3. Priča / The story

**HR.** Većina ljudi nikad neće sigurno čuvati seed phrase. To je glavni
razlog zašto kripto novčanici nisu probili u svakodnevicu — ne tehnologija,
nego onih 12 riječi koje moraš zapisati na papir i nikad izgubiti.
DOMOVINA Wallet kreće od suprotne pretpostavke: jedini uređaj kojem
korisnik vjeruje i koji uvijek nosi sa sobom je telefon, a jedina
autentikacija koju razumije je Face ID. Pa smo izgradili novčanik gdje
tvoj otisak/lice **jest** ključ — passkey u Keychainu potpisuje svaku
transakciju, a iza njega stoji Safe smart account na Gnosis Chainu. Eure
puniš običnim SEPA prijenosom (kroz Monerium), šalješ ih drugima skenom
QR-a, a gas plaćamo mi. Nikad ne vidimo tvoj novac niti tvoje ključeve.

**EN.** Most people will never safely store a seed phrase. That — not the
technology — is the real reason crypto wallets never crossed into everyday
life: the 12 words you must write on paper and never lose. DOMOVINA Wallet
starts from the opposite assumption: the only device a person trusts and
always carries is their phone, and the only auth they understand is Face
ID. So we built a wallet where your face/fingerprint *is* the key — a
passkey in the Keychain signs every transaction, backed by a Safe smart
account on Gnosis Chain. You top up with an ordinary SEPA transfer (via
Monerium), send by scanning a QR, and we pay the gas. We never see your
money or your keys.

**HR (vizija).** Ali novčanik je tek temelj. Dugoročni cilj je
kriptografski besprijekorno onchain glasanje vezano uz provjerenog
hrvatskog građanina — bez otkrivanja identiteta. Put ide preko hrvatskog
eID-a (Certilia, eIDAS High) i zk-dokaza, a invarijanta je ista kao prvog
dana: nijedan cloud ne drži ključ za potpisivanje, nijedan OIB ne završi
na disku u čistom tekstu.

**EN (vision).** But the wallet is only the foundation. The long-horizon
goal is cryptographically sound on-chain voting tied to a verified
Croatian citizen — without revealing identity. The path runs through
Croatian eID (Certilia, eIDAS High) and zk-proofs, and the invariant is
the same as day one: no cloud holds a signing key, no national ID number
ever hits disk in plaintext.

---

## 4. Kako radi / How it works

**Plain (HR).** Otvoriš stranicu, klikneš "Kreiraj wallet", potvrdiš Face
ID-em — gotovo. Nema lozinke, nema seed-a. Za uplatu: odabereš iznos,
dobiješ QR/SEPA podatke, platiš iz banke ili Revoluta, EURe stigne na tvoj
wallet. Za slanje: skeniraš tuđi QR ili zalijepiš adresu, upišeš iznos,
potvrdiš Face ID-em.

**Plain (EN).** Open the page, tap "Create wallet", confirm with Face ID —
done. No password, no seed. To receive: pick an amount, get a QR/SEPA
details, pay from your bank or Revolut, EURe lands in your wallet. To
send: scan someone's QR or paste an address, type an amount, confirm with
Face ID.

**Technical (EN).** On create, the browser runs WebAuthn `create()` (Face
ID + iOS Keychain) and we derive a P-256 signer and a **counterfactual**
Safe address — no on-chain deploy until first use. SEPA top-up posts a
payment-intent to `mpt.domovina.ai`; Monerium mints EURe into an MPT Safe
whose Zodiac Roles routing forwards it to the user's Safe (no per-recipient
backend change). Receiving P2P is a plain ERC-20 transfer via an EIP-681
QR/deep link. The activity feed is `viem` `getLogs` filtered by
topic == `safeAddress`, timestamps batched per unique block. Sending builds
a Safe `execTransaction` payload, signs it with the passkey (ERC-1271), and
POSTs to the CF Worker relay, which submits on-chain and pays xDAI gas
(5 free tx/day/passkey via a KV counter). If the Safe isn't deployed yet,
a MultiSend batch deploys + transfers in one tx. The backend registry holds
**only** public data (credentialId, P-256 pubkey, Safe address, phone
*hash*) — never keys.

Diagram + endpoint detalji / details: [`wallet/README.md` §Arhitektura](../../wallet/README.md).

---

## 5. Po čemu se razlikuje / Differentiators

| Kut / Angle | HR | EN |
|---|---|---|
| **vs. seed-phrase walleti** | Face ID umjesto 12 riječi; ništa za izgubiti ili zapisati. | Face ID instead of 12 words; nothing to lose or write down. |
| **vs. custodial (Revolut/burze)** | Ti držiš ključ; mi ne možemo zamrznuti ni vidjeti tvoj novac. | You hold the key; we can't freeze or see your money. |
| **vs. EOA (MetaMask)** | Smart account = gas-sponzorstvo, batch deploy+send, multi-passkey, ERC-1271. | Smart account = gas sponsorship, batch deploy+send, multi-passkey, ERC-1271. |
| **Gas UX** | 5 besplatnih tx/dan; korisnik nikad ne kupuje xDAI. | 5 free tx/day; the user never buys xDAI. |
| **Cross-device** | Isti passkey + Safe preko više `*.domovina.ai` domena i trećih dApp-ova. | Same passkey + Safe across `*.domovina.ai` and third-party dApps. |
| **White-label** | Brand-as-data: novi tenant = config, ne fork. | Brand-as-data: a new tenant is config, not a fork. |
| **Open-source put** | `open-wallet` template — analog `open-saas`-a. | `open-wallet` template — the `open-saas` analog. |
| **Identitet (roadmap)** | Sybil-otporan, anoniman onchain identitet vezan uz hrvatski eID. | Sybil-resistant, anonymous on-chain identity tied to Croatian eID. |

---

## 6. Roadmap

*Izvor istine: [ADR INDEX](../decisions/INDEX.md). Status legenda tamo.
Source of truth: ADR INDEX.*

**Isporučeno / Shipped (✅):**
- Self-custody passkey Safe wallet (ADR 0001)
- Brand-as-data white-label, 3 tenanta (ADR 0007)
- Multi-passkey / multi-domain isti Safe (ADR 0008)
- Iframe SDK MVP za dApp-ove (ADR 0009)
- Cross-device passkey recovery, phone OTP binding, activity history

**Planirano / Planned (⏳):**
- **Phase 5d-1** — Certilia eID (OIDC backend), eIDAS High LoA — *odblokirano danas / unblockable today* (ADR 0005)
- Phase 5 PhoneSBT contract (ADR 0003) — blokira na ADR 0004
- Phase 5c Android verifier mesh (ADR 0004) — **najveći blocker / single largest blocker**, 0 koda
- Polishing: ENS u activity feedu, address book, WalletConnect (README §Roadmap)

**Istraživanje / Research (🔬):**
- Phase 5e zkProof anonimni identitet + glasanje, Semaphore + BBS+ (ADR 0006) — 12–24 mj, €50–200k audit
- `open-wallet` open-source template (ADR 0010) — inkubira u `experiments/wallet-wasp/`

---

## 7. Dokazi / Proof points

*Konkretno, citabilno, provjerivo. Concrete, quotable, verifiable.*

- ✅ **Send pipeline validiran na pravoj Gnosis transakciji 2026-05-22**
  (passkey → WebAuthn → ERC-1271 → MultiSend deploy+send). / validated on a
  real Gnosis tx.
- ✅ **3 white-label tenanta live** — `wallet.domovina.ai`,
  `wallet-sportklub.pages.dev`, `wallet-zupa.pages.dev`.
- ✅ **10 ADR-ova** dokumentiraju svaku materijalnu odluku
  ([INDEX](../decisions/INDEX.md)). / 10 ADRs document every material
  decision.
- ✅ Relayer ekonomija: ~$10 xDAI pokriva ~15.000 transakcija. / ~$10 xDAI
  covers ~15,000 tx.
- ✅ Vlastiti reverse-OTP servis `otp.domovina.ai` za phone binding (hash
  only). / own reverse-OTP service, hash only.

---

## 8. Backlog blogova / Blog post backlog

*Svaki post = naslov (HR/EN) · publika · hook · outline · screenshotovi ·
kanal · CTA. Redoslijed = predloženi prioritet. Each = title · audience ·
hook · outline · shots · channel · CTA. Order = suggested priority.*

### B1 — "Novčanik bez seed phrasea" / "The wallet with no seed phrase"
- **Publika:** Hrvatska šira publika · **Jezik:** HR (EN sekundarno)
- **Hook:** Zašto 12 riječi nikad nisu prošle kod normalnih ljudi — i što
  smo stavili umjesto njih.
- **Outline:** problem seed-a → Face ID kao ključ → kako izgleda kreiranje
  (landing-welcome → home) → "mi ne vidimo ništa".
- **Screenshotovi:** `landing-welcome`, `hero`, `settings`.
- **Kanal:** domovina.tv blog · **CTA:** Otvori wallet.domovina.ai.

### B2 — "Napuni eure SEPA prijenosom" / "Top up euros with a SEPA transfer"
- **Publika:** Hrvatska šira · **Jezik:** HR
- **Hook:** Iz banke u kripto u jednom prijenosu — bez burze.
- **Outline:** Monerium/EURe ukratko → receive SEPA flow → live status
  uplate → rezultat na home-u.
- **Screenshotovi:** `receive-sepa`, `home`.
- **Kanal:** domovina.tv · **CTA:** isto.

### B3 — "Passkey-owned Safe: kako smo ubili seed phrase" / "Passkey-owned Safe: how we killed the seed phrase"
- **Publika:** Developeri / Web3 · **Jezik:** EN (HR sekundarno)
- **Hook:** WebAuthn P-256 → ERC-1271 → counterfactual Safe, end to end.
- **Outline:** WebAuthn create → predict signer+Safe → ERC-1271 verify →
  MultiSend deploy+send → relayer gas. Code + adrese.
- **Screenshotovi:** `send`, dijagram iz README-a.
- **Kanal:** dev.to / Hacker News / X · **CTA:** GitHub repo + ADR 0001.

### B4 — "Gas-sponsored sends bez da korisnik ikad dotakne xDAI" / "Gas-sponsored sends without the user ever touching xDAI"
- **Publika:** Developeri / Web3 · **Jezik:** EN
- **Hook:** Relayer pattern na CF Workeru: 5 free tx/dan, KV rate-limit,
  empty-address gotcha.
- **Outline:** zašto relay → pre-flight getCode → hot-first opasnost →
  KV brojač → ekonomija ($10 ≈ 15k tx).
- **Screenshotovi:** `send`, `dark-mode`.
- **Kanal:** dev.to / X · **CTA:** repo `functions/api/relay.ts`.

### B5 — "Jedan passkey, više domena" / "One passkey, many domains"
- **Publika:** Developeri / Web3 · **Jezik:** EN
- **Hook:** Parent-RP passkey + cross-TLD peer linking; isti Safe svuda.
- **Outline:** RP ID derivacija → ExpandAccess (intra-RP) → iframe vs
  Safari redirect linking → threshold-1 multi-owner. (ADR 0008)
- **Screenshotovi:** `landing-known`, `settings`.
- **Kanal:** dev.to · **CTA:** ADR 0008.

### B6 — "Drop-in EURe plaćanja u tvoj dApp" / "Drop-in EURe payments for your dApp"
- **Publika:** Developeri / Web3 · **Jezik:** EN
- **Hook:** `<script src=".../sdk.js">` i imaš EURe checkout — delegirano,
  ne custodijalno.
- **Outline:** iframe SDK arhitektura → `/embed` → postMessage → granice
  MVP-a. (ADR 0009)
- **Screenshotovi:** `receive-p2p` + embed primjer iz wallet-wasp-a.
- **Kanal:** dev.to / partneri · **CTA:** SDK docs.

### B7 — "open-wallet: open-saas za Web3 novčanike" / "open-wallet: the open-saas for Web3 wallets"
- **Publika:** WASP / open-source · **Jezik:** EN
- **Hook:** Self-hostaj brandirani self-custody EURe wallet; brand-as-data
  od prvog commita.
- **Outline:** zašto WASP rewrite → što generalizirati → kriteriji za
  rename u `open-wallet` → poziv contributorima. (ADR 0010)
- **Screenshotovi:** wallet-wasp set (`experiments/wallet-wasp/screenshots/`).
- **Kanal:** WASP community / GitHub / X · **CTA:** zvjezdica + repo.

### B8 — "Self-custody i MiCA: EURe kao EMT" / "Self-custody and MiCA: EURe as an EMT"
- **Publika:** Regulatorni / fintech · **Jezik:** HR + EN
- **Hook:** Zašto self-custody EMT novčanik ne nosi yield, i što to znači.
- **Outline:** EMT vs e-money → MiCA blokira yield-to-holders →
  Monerium bridge → granice. (ref: gnosis-pay ecosystem memo)
- **Screenshotovi:** `hero`, `receive-sepa`.
- **Kanal:** LinkedIn / fintech blog · **CTA:** kontakt za partnerstvo.

### B9 — "Onchain glasanje vezano uz hrvatskog građanina — anonimno" / "On-chain voting tied to a Croatian citizen — anonymously"
- **Publika:** Regulatorni/fintech + Web3 · **Jezik:** HR + EN
- **Hook:** Certilia eID + zk-dokazi: sybil-otporno, GDPR-usklađeno,
  anonimno.
- **Outline:** problem sybila → eIDAS High preko Certilije → PhoneSBT →
  Semaphore/BBS+ → verifier mesh bez clouda. **Jasno označiti: roadmap, ne
  isporučeno.** (ADR 0004/0005/0006)
- **Screenshotovi:** `phone-wizard` (jedini identitetski UI koji postoji danas).
- **Kanal:** policy blog / grant kontekst · **CTA:** pročitaj ADR-ove.

> **Napomena:** B9 je vizijski. Drži se §11 caveata — Phase 5 NIJE
> izgrađen. / B9 is visionary. Honor §11 — Phase 5 is NOT built.

---

## 9. Biblioteka screenshotova / Screenshot library

Lokacija / location: [`wallet/docs/screenshots/`](../../wallet/docs/screenshots/).
Capture proces: [`wallet/docs/screenshots/README.md`](../../wallet/docs/screenshots/README.md).

| Fajl | Pokazuje / Shows | Najbolji za / Best for |
|---|---|---|
| `hero.png` / `home.png` | Balance card + akcije + aktivnost | B1, B8, README hero |
| `landing-welcome.png` | Prvi posjet, 3 feature reda | B1 |
| `landing-known.png` | Multi-wallet kartice | B5 |
| `receive-sepa.png` | SEPA top-up forma | B2, B8 |
| `receive-p2p.png` | EIP-681 QR | B6 |
| `send.png` | Send + Face ID CTA | B3, B4 |
| `settings.png` | Račun + sigurnost hub | B1, B5 |
| `phone-wizard.png` | Reverse-OTP "Čekam SMS…" | B9 |
| `dark-mode.png` | Home, tamna tema | B4, social |
| `experiments/wallet-wasp/screenshots/*` | WASP rewrite UI | B7 |

> **Caveat za sadržaj:** trenutni `hero`/`home` prikazuju **0,00 EURe**
> (nijedan projektni wallet nije fundiran). Za marketing s pravim balansom
> i poviješću → vidi §11 + screenshot proces (fundiraj demo wallet,
> capturaj na pravom iPhoneu). / Current hero/home show **0.00 EURe**; for
> marketing with a real balance, fund a demo wallet and capture on a real
> iPhone.

---

## 10. Pojmovnik / Glossary

| Pojam / Term | HR | EN |
|---|---|---|
| **EURe** | Monerium e-novac (EMT), 1:1 euro, na Gnosisu | Monerium e-money token (EMT), 1:1 euro, on Gnosis |
| **Safe** | Smart-contract račun (smart account), ne obični ključ | Smart-contract account, not a plain key |
| **Passkey** | WebAuthn vjerodajnica u Keychainu; Face ID je otključava | WebAuthn credential in the Keychain; Face ID unlocks it |
| **Seed phrase** | 12/24 riječi koje su jedini backup kod klasičnih walleta — **mi ih nemamo** | The 12/24 words that are the only backup in classic wallets — **we have none** |
| **Self-custody** | Korisnik drži ključ; servis ne može pristupiti novcu | The user holds the key; the service can't access funds |
| **Counterfactual** | Safe adresa postoji prije deploya; deploya se na prvu tx | The Safe address exists before deploy; deploys on first tx |
| **ERC-1271** | Standard za potpise pametnih računa (Safe potvrđuje passkey potpis) | Smart-account signature standard (the Safe validates the passkey sig) |
| **Relayer** | Servis koji submitta tx i plaća gas umjesto korisnika | Service that submits the tx and pays gas for the user |
| **EIP-681** | URI format za on-chain plaćanje (naš P2P QR) | URI format for on-chain payment (our P2P QR) |
| **MiCA / EMT** | EU regulativa za kripto; EURe je e-money token pod njom | EU crypto regulation; EURe is an e-money token under it |
| **eIDAS High** | Najviša razina osiguranja eID-a (Certilia mIN je daje) | Highest eID assurance level (Certilia mIN provides it) |

---

## 11. Što NE tvrditi / Honesty guardrails

**Obavezno za svaku objavu. Binding for every published piece.**

| Nemoj tvrditi / Don't claim | Istina / Truth |
|---|---|
| "Pokazujemo pravi wallet s balansom" | Trenutni screenshotovi su **0,00 EURe** — nijedan projektni wallet nije fundiran. Real-balance shotove tek treba snimiti na pravom uređaju. |
| "Onchain glasanje / eID radi" | Phase 5 (ADR 0003–0006) je **planirano/istraživanje, 0 koda** za verifier mesh. Govori u futuru. |
| "P256 precompile na Gnosisu" | Status **nepotvrđen**; koristi se DaimoP256Verifier fallback. Ne tvrdi precompile. |
| "Potpuno anonimno već danas" | Anonimnost (zkProof) je 12–24mo istraživanje (ADR 0006), ne shipped. |
| "Mi čuvamo broj telefona" | Čuvamo **samo hash** (PHONE_PEPPER), nikad sirovi broj. |
| "Custodijalno / mi držimo novac" | **Nikad.** Self-custody invarijanta (ADR 0001). Relayer plaća gas, ne drži korisničke ključeve. |
| "open-wallet je gotov template" | Inkubira u `experiments/wallet-wasp/`; rename kriteriji još nisu ispunjeni (ADR 0010). |
| Tuđe adrese/iznose u slikama | Privatnost: koristi vlastite wallete (Glavni ↔ Ušteđevina) ili truncaj. |

---

## 12. Izvori / Sources

- [`wallet/README.md`](../../wallet/README.md) — tehnički SSOT (arhitektura, stack, deploy)
- [`docs/decisions/INDEX.md`](../decisions/INDEX.md) — ADR roadmap + status + dep graf
- ADR 0001–0010 — pojedinačne odluke / individual decisions
- [`wallet/docs/screenshots/README.md`](../../wallet/docs/screenshots/README.md) — capture proces
- `docs/competitor-analysis/`, `docs/research/`, `docs/integrations/` — dublji materijal
- Kontakt / Contact: Matija Stepanić — stepanic.matija@gmail.com — ITalk d.o.o.

---

*Održavanje / Maintenance: kad se ADR status promijeni ili se isporuči
nova faza, ažuriraj §2, §6, §7 i §11. Ovaj dokument je živ. / When an ADR
status changes or a phase ships, update §2, §6, §7, §11. This is a living
document.*
