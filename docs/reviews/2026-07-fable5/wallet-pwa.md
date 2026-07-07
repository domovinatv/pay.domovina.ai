# Wallet PWA — nalazi (WP-*)

Podsustav: `wallet/src/` (74 filea). Pokriveno finderima `wallet-state-storage`
(accounts/amount/balance/store/brands) i `wallet-routes-ui` (rute/embed/SDK/
komponente). Crypto jezgra (passkey/bootstrap/recover/paperWallet) je
**pod-pokrivena** — vidi INDEX coverage mapu + F0 u refactor-planu.

> **Confidence napomena:** WP-01/02/03/06 dolaze iz `wallet-state-storage`
> findera i **nisu prošli Opusov ručni re-verify** (verify pass je pao na
> kreditima). Opus je verificirao samo `webauthnSig.ts` (GOOD) i relayer safe
> pipeline. Nalazi su plauzibilni i imaju konkretan file:line, ali Opus ih
> treba re-checkati čitanjem `accounts.ts` PRIJE fixanja — osobito WP-01/02 jer
> diraju self-custody invarijantu (ADR 0001).

---

## WP-01 [SEC] `syncAccountsWithBackend` persistira backend račune bez lokalne verifikacije

**file:** `wallet/src/lib/accounts.ts:291` · *(finder; Opus re-verify TODO)*

**Failure scenarij:** `syncAccountsWithBackend` povuče račune s backenda i
persistira ih lokalno bez provjere da lokalni uređaj kontrolira taj Safe /
signer. Injektiran backend zapis s napadačevim `recoveryOwner` postaje lokalno
prikazan račun; ako korisnik u njega uplati, napadač (kao recovery owner) može
drainati. Dotiče self-custody: backend NE smije moći dodati identitet koji
korisnik nije kreirao.

**Fix:** Prihvatiti backend račun samo ako se njegova adresa deriva iz
lokalno-poznatog signera/seeda (client-side predict === backend address), inače
ga tretirati kao read-only/nepovjerljiv i NE nuditi uplatu.

**Acceptance:** Test: backend vrati račun s nepoznatim signerom → ne pojavljuje
se kao spendable; predict-match račun → prihvaćen.

---

## WP-02 [SEC] `ensureRecoveryOwner` trusta backend `recovery_owner` za nedeployani Safe

**file:** `wallet/src/lib/accounts.ts:387` · *(finder; Opus re-verify TODO)*

**Failure scenarij:** Za nedeployani (counterfactual) Safe, `ensureRecoveryOwner`
uzima `recovery_owner` iz backenda i trajno ga upiše u identitet. Budući da
recovery owner ulazi u CREATE2 initializer (2-owner Safe, ADR 0013), poison
vrijednost mijenja derived adresu SVIH budućih računa iz tog seeda → korisnik
funda adrese čiji je 1-of-2 co-owner napadač.

**Fix:** Recovery owner mora biti lokalno izveden (iz korisnikovog seeda), nikad
prihvaćen iz backend odgovora za nedeployani Safe. Backend smije samo POTVRDITI
već lokalno poznatu vrijednost, ne je DIKTIRATI.

**Acceptance:** Test: backend vrati drugačiji `recovery_owner` od lokalno
izvedenog → odbijeno, identitet nepromijenjen.

---

## WP-03 [BUG] Arhivirani derived račun uskrsne na svakom ulasku

**file:** `wallet/src/lib/accounts.ts:288` · *(finder; Opus re-verify TODO)*

**Failure scenarij:** Archive računa je samo lokalno stanje; `syncAccountsWithBackend`
ga povuče natrag jer nema backend delete ni lokalni tombstone → arhiviran račun
se vrati na svakom ulazu u wallet.

**Fix:** Tombstone (lokalni "archived" set koji sync poštuje) ili backend
soft-delete flag.

**Acceptance:** Arhiviraj → reload → račun ostaje skriven.

---

## WP-04 [BUG] `setIdentity` ne čisti stale balance prethodnog računa

**file:** `wallet/src/state/store.ts:44`

**Failure scenarij:** `setAccount` čisti balance, ali `setIdentity` ne — nakon
prebacivanja identiteta UI nakratko prikaže balance prethodnog računa (stale),
što na Send ekranu može zavarati korisnika o raspoloživom iznosu.

**Fix:** `setIdentity` također resetira `balance` na null/loading.

**Acceptance:** Prebaci identitet → balance polje je "…"/0 do refetch, ne stara
vrijednost.

---

## WP-05 [BUG] Receive šalje `amountEur` kao float s do 18 decimala

**file:** `wallet/src/routes/Receive.tsx:108`

**Failure scenarij:** Receive konstruira SEPA/intent iznos kao float s do 18
decimala; backend intent radi u centima (`amount_cents`) pa tiho zaokruži.
Nekonzistentnost precision između klijenta i backenda; rubni iznosi (npr.
0.005) se zaokruže neočekivano.

**Fix:** Klijent validira/formatira na 2 decimale (cente) prije slanja; jedan
`toCents` helper dijeljen s amount.ts.

**Acceptance:** Test: unos `1.005` → definiran, konzistentan iznos na obje strane.

---

## WP-06 [BUG] `loadAccounts`/simpleMode ne guardaju JSON primitive

**file:** `wallet/src/lib/accounts.ts:85` · *(finder; Opus re-verify TODO)*

**Failure scenarij:** `JSON.parse` localStorage vrijednosti koja je primitiv
(`"null"`, `"true"`, broj) prođe bez tipa-guarda → picker/odabir računa dobije
ne-array/ne-objekt → crash. Koruptiran ili djelomično zapisan storage ruši
onboarding.

**Fix:** Nakon `JSON.parse`, provjeriti `Array.isArray`/`typeof === 'object'`
prije upotrebe; fallback na prazno stanje.

**Acceptance:** localStorage postavljen na `"null"` → wallet se učita s praznim
stanjem, ne crash.

---

## WP-07 [RISK] Send relay false-timeout → double-send na retry

**file:** `wallet/src/routes/Send.tsx:372`

**Failure scenarij:** Ako relay tx zapravo prođe ali odgovor timeouta (mreža),
UI nema klijentsku idempotenciju → korisnik pritisne "Pošalji ponovno" → drugi
relay poziv → dupli transfer. UI twin od WR-01.

**Fix:** Klijentski idempotency key (npr. hash od `{safe, to, value, nonce}`) i
"provjeri je li prethodni tx prošao" prije re-broadcasta; disable dugmeta +
"provjeravam status" stanje.

**Acceptance:** Simuliran timeout uz uspješan tx → retry ne šalje drugi transfer.

---

## WP-08 [RISK] `/recover` pre-fila full-balance sweep destinaciju iz URL-a

**file:** `wallet/src/routes/Recover.tsx:41`

**Failure scenarij:** `/recover` na neautenticiranom entry pointu čita
destinaciju sweepa (cijeli balans) iz URL parametra → phishing: napadač pošalje
`wallet.domovina.ai/recover?...&to=<napadač>` i korisnik nesvjesno potvrdi sweep
na napadačevu adresu.

**Fix:** Ne pre-filati destinaciju iz URL-a za sweep; destinacija mora biti
korisnikov drugi vlastiti račun (odabir iz liste), nikad slobodan URL param. Ako
mora, jasan warning + potvrda adrese.

**Acceptance:** `/recover?to=0xNapadač` → adresa NIJE pre-filana; korisnik bira
odredište iz vlastitih računa.

---

## WP-09 [RISK] Embed `send()` nema threshold>1 pre-check koji Send.tsx ima

**file:** `wallet/src/routes/Embed.tsx:255`

**Failure scenarij:** `Send.tsx` provjeri threshold>1 i vodi korisnika na
app.safe.global (relay šalje samo 1 passkey potpis). Embed put nema tu provjeru
→ na Safe-u s threshold>1 transakcija tiho faila/revert-a bez jasne poruke u
embed kontekstu.

**Fix:** Podijeliti threshold-guard u dijeljeni helper koji i Send i Embed
koriste.

**Acceptance:** Embed send na threshold-2 Safe → jasna poruka, ne opaki revert.

---

## WP-10 [BUG] SDK `connect()` proždire `createAccount()` povratnu vrijednost

**file:** `wallet/public/sdk.js:122`

**Failure scenarij:** `connect()` pohlepno konzumira return od `createAccount()`
→ kreiran račun se tiho izgubi ili nastane redirect loop u third-party dApp
integraciji.

**Fix:** Razdvojiti message-handling za `connect` vs `createAccount` (provjera
`type`/`id` prije konzumiranja).

**Acceptance:** dApp pozove `createAccount()` → dobije adresu, nema loopa.

---

## WP-11 [RISK] GP card fund gate: "≤50€ bez 2. ownera" nije enforced

**file:** `wallet/src/components/GpCardScreen.tsx:247`

**Failure scenarij:** Komentar tvrdi kumulativni limit "≤50€ bez drugog ownera",
ali kod ga ne provjerava → korisnik s 1/1 passkey-only Safe-om može funddirati
GP karticu iznad namjeravanog limita, protiv trapped-funds mitigacije
(postmortem 0001).

**Fix:** Ili enforce-ati limit u kodu, ili maknuti komentar koji laže o
kontroli koja ne postoji.

**Acceptance:** Fund > 50€ na 1/1 Safe → blokiran ili eksplicitno dozvoljen (bez
lažnog komentara).

---

## WP-12 [REFACTOR] `formatEureShort` zaokružuje umjesto trunkacije

**file:** `wallet/src/lib/balances.ts:47`

**Failure scenarij:** Funkcija zaokružuje (contra vlastiti komentar koji kaže
trunkacija) → picker može prikazati VEĆI balance od stvarnog (npr. 9.999 → 10.00),
korisnik misli da ima više. Uz to `balance.ts` i `balances.ts` dupliciraju isti
fetch. Kozmetički za male iznose ali zavaravajuće.

**Fix:** Trunkacija (floor) za prikaz balansa; konsolidirati dva fetch modula.

**Acceptance:** 9.999 EURe → prikaz "9.99", ne "10.00".
