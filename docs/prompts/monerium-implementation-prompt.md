# PROMPT: Implementacija Monerium per-user integracije u DOMOVINA Wallet

> **Kako koristiti**: u praznom Claude Code chatu (cwd = ovaj repo) napiši:
> `Pročitaj docs/prompts/monerium-implementation-prompt.md i kreni s implementacijom.`
> Trajni zapis točnog prompta po kojem se radi implementacija. Verzija 1.0 · 2026-06-11.

## Cilj (odluka Matije, 2026-06-11)

Prijeći s MPT hold-and-forward on-rampa na **per-user Monerium model**: end-customer kroz naš
softver postaje Moneriumov klijent, prolazi Moneriumov KYC, dobiva **vlastiti personalizirani
IBAN** vezan na svoj DOMOVINA Safe; mint EURe ide **direktno u korisnikov Safe** (ITalk potpuno
izvan toka novca). Bonus-cilj: korisnik se može logirati na monerium.app i vidjeti svoje Safe
adrese iz DOMOVINA Walleta. MPT rail ostaje za legacy/prijelaz dok Monerium ne odobri model.

## Kontekst (pročitaj PRIJE koda, ovim redom)

1. `docs/compliance/INTERNO-monerium-tos-analiza.md` — ZAŠTO ovaj model (BToS §16!) +
   OAuth-vs-Whitelabel nijansa (dedicated IBAN vs monerium.app vidljivost)
2. `docs/compliance/monerium-outreach-email.md` — što je pitano Monerium (status odgovora
   provjeri s Matijom prije produkcijskih koraka; **sandbox ne čeka nikoga**)
3. `docs/compliance/README.md` — javna compliance pozicija koju implementacija mora očuvati
4. Sirova dokumentacija (cache): `~/.cache/monerium-docs/pages/` — ključne stranice:
   `oauth.md` (OAuth/PKCE/SIWE flow), `whitelabel.md` (profiles, KYC Sharing via Sumsub,
   dedicated IBAN), `api.md` (125 KB, svi endpointi), `authorization.md`, `sandbox.md`,
   `kyc-guide-individuals.md`, `contracts-v2.md`
5. Postojeća (legacy, Private-plan) integracija: `backend/src/monerium/` (client, webhook,
   db) + `docs/monerium-private.md`, `docs/reference/monerium-contracts.md` — NE rušiti,
   per-user model ide PARALELNO uz nju
6. Wallet: `wallet/src/lib/safe.ts` (EIP-1271, predict/deploy), `wallet/src/lib/passkey.ts`,
   postojeći Receive flow (`wallet/src/routes/Receive.tsx` — tu dolazi "Moj IBAN" opcija)

## Tvrda pravila

- **SVE razvijati protiv sandboxa** (`docs.monerium.com/sandbox`; sandbox API base + testni
  SEPA) dok Monerium ne odobri partnerstvo/model za produkciju.
- Address linking poruka je FIKSNA: `I hereby declare that I am the address owner.` —
  Safe EIP-1271 potpis (off-chain combined signatures, Monerium zove `isValidSignature`)
  ili on-chain `signMessage` fallback (Monerium polla do 5 dana). **Safe mora biti deployan**
  prije 1271 linkanja (pre-flight `getCode` — postojeće house pravilo).
- Jedan korisnik = jedan Monerium profil (njihov hard constraint). Prije kreiranja profila
  provjeriti postojeći (korisnici koji su već Monerium klijenti → link-existing flow). Pazi
  i na GP-ov IBAN wrapper (kartični korisnici) — ista osoba ne smije dobiti dupli profil.
- ITalk backend NIKAD ne smije postati holder sredstava — nijedan endpoint ne smije primati
  ni prosljeđivati vrijednost; backend samo orkestrira profile/IBAN-e/webhookove.
- KYC podaci: ne pohranjivati ništa osim statusa profila (GDPR scope ostaje minimalan).
- Mint destinacija = korisnikov Safe (linked address), nikad default/ITalk adresa.

## Koraci (svaki = zaseban commit, conventional commits, push odmah)

**Faza 0 — sandbox spike + odluka OAuth vs Whitelabel**
1. Sandbox credentials + `scripts/monerium-spike.mjs`: client_credentials auth → kreiraj
   testni profil → submitaj testne KYC podatke → linkaj testni Safe (EIP-1271) → IBAN →
   simuliraj SEPA uplatu → potvrdi mint na linkanu adresu. Dokumentiraj svaki response.
2. Testiraj i OAuth flow (PKCE + `authentication_method: 'siwe'`) — može li naš passkey
   Safe biti SIWE identitet kod Moneriuma.
3. Nalazi + preporuka (OAuth / Whitelabel / hibrid) u `docs/plans/monerium-per-user/findings-faza0.md`.
   Ako je Monerium do tada odgovorio na email — njihova preporuka pobjeđuje.

**Faza 1 — backend orkestracija (sandbox)**
4. `backend/src/monerium-user/` modul (odvojen od legacy `monerium/`): profile lifecycle
   (create/share/status), webhook handler za `profile.updated` + `order.*` (postojeći
   idempotency obrazac), D1 migracija `monerium_profiles` (credential_id, safe_address,
   profile_id, iban, status — bez osobnih podataka).
5. Wallet API: endpointi za pokretanje onboardinga i status (auth = postojeći wallet registry).

**Faza 2 — wallet UI**
6. Receive flow: nova opcija **"Moj osobni IBAN"** uz postojeći SEPA-na-ITalk QR: onboarding
   wizard (Monerium KYC — iframe/redirect ovisno o planu) → prikaz vlastitog IBAN-a + BIC +
   "uplate stižu direktno u tvoj novčanik".
7. Address linking ceremonija u UI-ju (passkey potpis fiksne poruke; deploy Safe-a prije
   ako je counterfactual — postojeći relay cold-path).
8. Multi-account: linkanje dodatnih derived accounta na isti profil (`POST /addresses` po računu).

**Faza 3 — suživot tri on-rampa**
9. Routing logika u Receive: osobni IBAN (ima profil) / MPT rail QR (legacy, dok je odobren) /
   GP IBAN (kartični korisnici) — jedan jasan UX, bez duplih profila.
10. Legacy MPT: US-exclusion klauzula u uvjete korištenja + SEPA recall rezerva (vidi INTERNO
    dokument, §18/§19(6)).

**Produkcija**: tek nakon (a) Moneriumovog odgovora/partner odobrenja, (b) Matijine potvrde.

## Definition of done
- Sandbox e2e: SEPA (test) uplata → EURe u korisnikovom sandbox Safe-u bez ijednog dodira
  ITalk adresa; webhook ažurira status; UI prikazuje IBAN.
- Svaka razlika docs-vs-stvarnost dokumentirana u findings datoteci.
