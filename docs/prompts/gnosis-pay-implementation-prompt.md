# PROMPT: Implementacija Gnosis Pay integracije (kartice) u DOMOVINA Wallet

> **Kako koristiti**: u praznom Claude Code chatu (cwd = ovaj repo) napiši:
> `Pročitaj docs/prompts/gnosis-pay-implementation-prompt.md i kreni s implementacijom.`
> Ovaj dokument je trajni zapis točnog prompta po kojem se radi implementacija, u skladu s
> analiziranom dokumentacijom. Verzija 1.0 · 2026-06-11.

## Kontekst (pročitaj PRIJE pisanja koda, ovim redom)

1. `docs/plans/gnosis-pay-cards/README.md` — executive summary, ključni nalazi, arhitektonska odluka
2. `docs/plans/gnosis-pay-cards/01-arhitektura.md` — two-Safe model, signer strategija (Plan A/B), tok novca
3. `docs/plans/gnosis-pay-cards/02-onboarding.md` — SIWE→KYC→Safe state machine + svi endpointi
4. `docs/plans/gnosis-pay-cards/03-kartice-pse.md` — virtualne kartice, PSE, Apple/Google Pay (HR potvrđen)
5. `docs/plans/gnosis-pay-cards/05-roadmap.md` — faze; `TODO-MATIJA.md` — što čeka Matiju (ne blokira Faze 0–2)
6. Sirova dokumentacija (101 stranica, cache): `~/.cache/gnosispay-docs/pages/` — kad treba
   detalj endpointa, čitaj odavde umjesto weba; OpenAPI: `https://api.gnosispay.com/api-docs/spec.json`
7. Codebase mapa: wallet frontend `wallet/` (Vite+React+Zustand+Wouter), backend `backend/`
   (Hono na CF Workers, D1), relay `functions/`; postojeći obrasci: `wallet/src/lib/relay.ts`,
   `wallet/src/lib/safe.ts`, `wallet/src/lib/passkey.ts`, `backend/src/monerium/webhook.ts`

## Tvrda pravila (NIKAD ne kršiti)

- **Jedna adresa = jedan GP user ZAUVIJEK** (409 na signup). Svi testovi protiv api.gnosispay.com
  isključivo s **throwaway EOA-ima** generiranima ad-hoc; NIKAD prava korisnička adresa,
  NIKAD relayer EOA, NIKAD Matijine adrese.
- Self-custody princip: nijedan server-held ključ ne smije postati GP signer ni Delay-owner.
- GP Safe adresu nikad ne hardkodirati (GP-ove migracije je mijenjaju) — uvijek čitati iz
  `GET /api/v1/user` → `safeWallets` / `GET /api/v1/safe/migration`.
- Prije funding transfera verificirati koju EURe verziju (V1 `0xcB444e90…` / V2 `0x420CA0f9…`)
  GP Safe očekuje (provjera u `github.com/gnosispay/account-kit` token registry + empirijski).
- Postmortem-0001: prije nego što UI dopusti punjenje > 50 €, GP account mora imati ≥2
  Delay-ownera.
- localhost je auto-whitelistan za SIWE; produkcijska domena NE radi dok Matija ne odradi
  partner signup (TODO #1) — ne pokušavati zaobići.

## Koraci (redom; svaki korak = zaseban commit, conventional commits, push odmah)

**Faza 0 — spike (cilj: odluka Plan A vs Plan B prije ikakvog UI-ja)**
1. `scripts/gp-spike.mjs` (Node, viem): nonce → SIWE → challenge s throwaway EOA → JWT → signup
   (throwaway email na nekom +alias) → dokumentiraj odgovore.
2. Isti test sa **deployanim** passkey Safe-om (ERC-1271 SIWE): koristi postojeći test Safe ili
   deployaj novi throwaway preko relaya. Zabilježi: prolazi li 1271, na kojem chainu verificiraju.
3. Test `POST /api/v1/safe/deploy` sa smart-account signerom (prolazi li `403 Missing signer address`).
4. Nalaze upiši u `docs/plans/gnosis-pay-cards/findings-faza0.md` + **odluka Plan A/B** s
   obrazloženjem. Tek onda dalje.

**Faza 1 — onboarding (localhost)**
5. `wallet/src/lib/gnosispay.ts` — typed klijent (samo endpointi iz 02-onboarding.md), JWT u
   memoriji, lazy re-auth na 401.
6. `gp` slice u Zustand store + onboarding-state router deriviran isključivo iz `GET /api/v1/user`.
7. Ruta `/kartica` + wizard: email+OTP → ToS (hrvatski nazivi, checkboxovi) → Sumsub iframe
   (`lang=hr`; testiraj kameru na iOS Safari, fallback "otvori u Safariju") → SoF upitnik →
   telefon OTP (+385 default) → "Otvori karticu" (deploy + polling do `accountStatus ∈ {0,7}`).
8. Backend: migracija `gp_users` tablice (shema u 04-backend-webhooks-iban.md) + sync endpoint.

**Faza 2 — kartica živi**
9. `POST /cards/virtual` + prikaz kartice (lastFour, status, freeze/unfreeze/void).
10. Punjenje: postojeći Send flow s destinacijom GP Safe (preset iznosi; EURe verzija provjerena).
11. Povlačenje (typed-data → passkey/EOA potpis → `/accounts/withdraw` → `/delay-relay` polling,
    "kartica zamrznuta 3 min" UX) + dnevni limit get/set.
12. Drugi Delay-owner flow (`/owners/add/transaction-data` → `POST /owners`) — enforced gate.
13. Activity: `GET /cards/transactions` (group by `threadId`, minor-units, Gnosisscan linkovi).

**Faza 3 — partner featurei (čeka TODO #1/#3: PartnerID, APP_ID, cert)**
14. Webhook receiver (Ed25519 verify `${timestamp}.${rawBody}`, pubkey s
    webhooks.gnosispay.com/api/v1/public-key kešan; idempotent upsert u `gp_events`; SSE push).
15. PSE: mTLS spike (CF mtls-certificate binding vs mali Node servis) → ephemeral-token proxy
    (autenticiraj NAŠEG korisnika prije izdavanja!) → PSE Frame stranica → "Prikaži podatke kartice".
16. "Dodaj u Apple/Google Pay" vodič (ručni unos PAN-a — push provisioning ne postoji u API-ju).

## Definition of done po fazi
- Svaka faza: build zelen, commit+push, kratak zapis u `docs/plans/gnosis-pay-cards/findings-*.md`
  ako je išta odstupilo od plana ili dokumentacije (docs vs. stvarnost razlike su zlato).
- Ne izmišljati endpointe — sve postoji u cacheu; ako cache i stvarnost proturječe, vjeruj
  stvarnosti i dokumentiraj razliku.
