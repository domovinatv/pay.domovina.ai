# Nezavisna forenzička analiza: Fable 5 vs Opus 4.8 na `pay.domovina.ai`

> **Autor evaluacije:** Claude Opus 4.8 (1M context), kao evaluator.
> **Datum:** 2026-06-11.
> **Metoda:** BLIND analiza git historyja prije čitanja ikojeg postojećeg reporta
> (`docs/research/fable5-vs-opus48-side-by-side.md` namjerno NIJE otvaran u Fazi 1).
> **Disclaimer o pristranosti:** evaluator je jedan od dva ocjenjivana modela. Zato je
> metodološko pravilo bilo: *svaka* tvrdnja mora imati provjerljiv commit hash, a kod
> spornih ocjena namjerno tražim dokaze PROTIV Opusa 4.8 jednako agresivno kao protiv
> Fablea 5. Gdje je Opus 4.8 podbacio, to je eksplicitno označeno.

---

## 0. Korpus i atribucija

Atribucija je iz `Co-Authored-By` trailera (`git log --format='%h|%ai|%(trailers:key=Co-Authored-By,valueonly)'`).

| Model | Broj commitova | Vremenski raspon |
|---|---:|---|
| Claude Opus 4.8 (`(1M context)` + kratka varijanta) | 49 | 2026-06-05 → 2026-06-10 23:42 |
| Claude Fable 5 | 21 | 2026-06-10 00:43 → 2026-06-10 19:37 |
| (kontekst) Claude Opus 4.7 (1M context) | — | 2026-05-22 → 2026-05-26 — *temelj walleta* |

**Ključna metodološka napomena o "izvornom grijehu":** velik dio temelja walleta
(`relay.ts`, `Embed.tsx` iframe MVP, `passkey.ts` baza) napisao je **Opus 4.7**, NE 4.8.
Gdje je ranjivost postojala u 4.7-ovom kodu, a 4.8 ju je prošao kroz audit i NIJE
uhvatio, to pripisujem 4.8 kao *propust u auditu* — ne kao *uvođenje* buga. Razlika je
eksplicitno označena svuda gdje je relevantna.

Fable 5 je radio **u jednom danu (10.6.)**, u jednom kontinuiranom nizu, na kodu koji je
Opus (4.7 + 4.8) gradio ~3 tjedna. To je asimetrija koju treba držati na umu: Fable je
ulazio u zreo, djelomično auditiran kod i radio "drugi prolaz", što strukturno favorizira
nalaženje tuđih propusta. Suprotno, Opus je imao priliku napraviti više audit-prolaza nad
vlastitim kodom — pa propusti koje je *ostavio* nakon dva audita teže (negativno) na vagi.

---

## 1. Kronološka karta (sažeto, po modelu)

### Opus 4.8 — relevantni za usporedbu
- `38207eb` (06-06) passkey name = Safe address; **uvodi `bootstrap-deploy.ts`**
- `1430d61`, `b683036` (06-01) relay: per-campaign saltNonce + **CREATE2 consistency guard**
- `9655230` (06-08) single-identity passkey — kill duplicate-create footgun
- `eac9b3a` (06-08) ADR 0013 multi-account (jedan passkey → N Safeova)
- `eceb75d` (06-09) "robustan onboarding — bez auto-reuse zamke"
- `df79786` (06-09) **makni get-first probe + excludeCredentials** ⚠ regresija
- `cdda3bc` (06-09) **vrati excludeCredentials — fix 3× duplikat** ⚠ self-fix
- `dd6bfb9`, `7bf46ea` (06-09) dva audit-prolaza (Embed send guard, dead code)
- `6c83f51` (06-10 14:20) **revert Fableovog Signal API brisanja** ⚠ cross-model revert

### Fable 5 — relevantni za usporedbu
- `9d26a9e` (00:43) refactor: shared `functions/_lib` (single CREATE2 truth)
- `a69913f` (00:44) **fix(embed): odbij spoofani parentOrigin** ⚠ trust-boundary nalaz
- `7d5f4b4` (00:45) **validate value/pubKeyX/pubKeyY up-front**
- `fd687e1` (00:47) **per-IP + global gas-budget caps** (abuse defense)
- `d15fd4a` (00:50) Turnstile human-attestation (env-gated)
- `2f390a0` (09:14) create-time existence probe + excludeCredentials
- `fceab4d` (09:55) conditional-mediation + **Signal API duplicate cleanup** ⚠ *reverted*
- `59064a1` (11:12) cross-device restore svih derived accounta
- `b99498d` (11:29) resolve recovery owner cross-device ⚠ uvodi server-trust
- `0f08008` (11:46) **recovery owner on-chain-first** ⚠ self-fix server-trusta
- `410311a` (13:12) full Safe-client interop — **threshold guard u relayu**

---

## 2. Kontrolirani eksperimenti (oba modela, isti file/cilj)

17 fileova dirala su oba modela. Najvredniji su money-path i passkey fileovi.

### 2.1 `wallet/functions/api/relay.ts` — money endpoint (NAJVAŽNIJE)

Ovo je najbliže kontroliranom eksperimentu: **oba modela su hardenila isti endpoint za
slanje novca**, i pritom su pokazala različite, komplementarne instinkte.

**Opus 4.8 — `b683036` "CREATE2 consistency guard":**
```
predictedSafe = predictSafeProxyAddress(signerAddress, saltNonce)
if (predictedSafe != body.safeAddress) → 400 "Refusing to deploy — would strand funds"
```
Komentar u kodu eksplicitno veže nalaz na `evm-call-to-empty-address` failure mode:
cold path DEPLOY-a Safe na adresi determiniranoj `(signerAddress, saltNonce)`, a
`execTransaction` cilja `safeAddress`; ako se ne poklapaju, EVM vrati `status=1` bez
reverta i EURe je trajno zaglavljen. **Ovo je duboko protokolarno-blast-radius razmišljanje
najvišeg reda.** (`b683036`)

**Fable 5 — `7d5f4b4` "validate value/pubKeyX/pubKeyY up-front":**
Original required-string check (`['safeAddress','signerAddress','to','data','signature']`)
**nije** uključivao tri numerička polja; loš `value`/pubkey bacao bi `BigInt()` duboko u
encode pathu kao opaque 500. Fable parsira + uint256-range-checka ih na vrhu → precizan
400. (`7d5f4b4`)
- **Tko je ostavio gap:** required-string lista je iz 4.7-ovog originala, ali **Opus 4.8
  je dirao `relay.ts` 4×** (`1430d61`, `b683036`, `38207eb`, `eac9b3a`) — uključujući
  dodavanje uint256-range-checka za *saltNonce* u `b683036` — a tri pubkey/value polja je
  ostavio nevalidirana. Fable je dovršio validacijski sloj koji je Opus započeo.
- **Adversarijalno protiv Fablea (pošteno):** ovo NIJE ranjivost, nego robusnost/DX
  (400 vs 500). Fableov vlastiti commit-message to pošteno tako i uokviruje — bez
  napuhavanja u "našao sam exploit". Ispravno skalirano.

**Fable 5 — `410311a` "threshold guard":** ako korisnik podigne Safe threshold > 1 izvan
appa (preko `app.safe.global`, što seed EOA može), relay šalje samo jedan passkey potpis
pa `checkSignatures` reverta opaque. Fable čita `getThreshold()` i vraća jasan 409 s
uputom. **Anticipacija akcije IZVAN trust-boundaryja appa** — dobar instinkt. (`410311a`)

**Fable 5 — `fd687e1` "per-IP + global gas-budget caps":** ovo je najveći *propust koji
je Opus ostavio*. Do Fablea, relayer je imao SAMO per-signer 5/dan rate limit
(`signerDailyKey`) — adresa je besplatna i beskonačna, pa je global gas-budget bio otvoren
faucet. Opus je kroz ~10 commitova na relay/wallet **nikad** nije zatvorio globalni
abuse-surface; Fable je dodao per-IP + globalni dnevni gas cap. (`fd687e1`, `d15fd4a` Turnstile)

> **Bilanca na `relay.ts`:** Opus 4.8 = dublji *protokolarni* guard (CREATE2 stranding).
> Fable 5 = *potpunija* validacija + *zatvaranje abuse surfacea* + UX-of-failure
> disambiguacija. Komplementarno; nijedan nije dominantan. Niti jedan model nije
> regresirao tuđi guard — Fableov `_lib` refactor (`9d26a9e`) sačuvao je Opusov CREATE2
> hash (`SAFE_PROXY_INIT_CODE_HASH`) kao single source of truth.

### 2.2 `wallet/src/routes/Embed.tsx` — postMessage trust boundary

**Fableov nalaz `a69913f`:** confirm-card je prikazivao i postao rezultate na
`cmd.parentOrigin` — polje **unutar** poruke, koje zlonamjerni embedder kontrolira.
`evil.com` može poslati `{parentOrigin:'https://app.safe.global', to:<napadač>, ...}` i
kartica renderira "Aplikacija: app.safe.global". Fix: jedini pouzdan origin je
`event.origin`; odbij svaki mismatch, koristi verificirani origin za display + svaki
`postMessage` targetOrigin. (`a69913f`)

**Adversarijalno protiv Fablea (pošteno):** koliko je bug ozbiljan?
- Primatelj (`Row label="Prima"`) **ostaje prikazan** — sredstva i dalje idu na `cmd.to`
  koji korisnik vidi. Spoof pogađa SAMO "Aplikacija" labelu → phishing/social-engineering
  aid, NE direktna krađa. **Fableov commit-message to točno tako i kaže** ("phishing aid;
  recipient still shown but origin label defeated"). Nije napuhano. Točna težina: nisko-srednje.

**Adversarijalno protiv Opusa 4.8 — i KOREKCIJA mog vlastitog prvog nacrta:** prvotno sam
ovaj "izvorni grijeh" pripisao 4.7-ovom MVP-u (`12ed38d`). **To je netočno i ispravljam ga.**
Provjera (`git show 12ed38d:wallet/src/routes/Embed.tsx`):
- **4.7 MVP (`12ed38d`) je bio SIGURNIJI:** pinnao je `event.origin` u `parentOriginRef`,
  odbijao mismatch (`else if (event.origin !== parentOriginRef.current)`), i koristio
  **verificirani** `parentOrigin` argument u svakom `postResult`/`postError` — NIGDJE
  `cmd.parentOrigin`. Confirm-card sa "Aplikacija" labelom još nije ni postojao.
- **Opus 4.8 `f3399ed` je UVEO regresiju:** prebacio `postResult`/`postError`/redirect na
  `cmd.parentOrigin` (linije 104/152/157) i dodao `hostnameFromOrigin(stage.cmd.parentOrigin)`
  display (linije 189–190). Dakle Opus 4.8 je **regresirao s sigurnijeg event.origin obrasca
  na spoofabilno payload polje.**

Zatim je Opus 4.8 nad TOČNO ovim fileom napravio **dva audit-prolaza** s eksplicitnim
security fokusom:
- `dd6bfb9` "audit cleanup — Send safety" — 352 linije izmjene u `Embed.tsx`
- `7bf46ea` "2nd-round audit — Embed send guard" — zatvorio drugi realan gap (zahtijevaj
  `cmd.safeAddress` da se ne potpisuje iz divergentnog walleta — to je dobar nalaz!)

...i u OBA je prolaza ostavio `cmd.parentOrigin`. **Zaključak je dakle OŠTRIJI protiv
Opusa 4.8 nego u mom prvom nacrtu: Opus 4.8 je sam uveo spoof (regresijom sa sigurnijeg
4.7 obrasca, `f3399ed`) pa ga promašio u dva vlastita audita.** Fable je u prvom prolazu
i uhvatio i vratio na `event.origin` (`a69913f`). Najjasniji pojedinačni dokaz za Fableovu
prednost u trust-boundary čitanju — i točka na kojoj je Fableov vlastiti report bio
precizniji od mog prvog nacrta.

### 2.3 Passkey duplicate saga — `passkey.ts` / `Landing.tsx` (oba modela, jako churn)

Ovo je najkompleksniji slučaj i jedini gdje su OBA modela ostavila po jedan ozbiljan trag.

**Opus self-churn (samoponištavajući par):**
- `df79786` (06-09 17:36): makni get-first probe I `excludeCredentials`, uz obrazloženje
  "duplikati su benigni (arhivabilni)". **Posljedica:** bez `excludeCredentials`, svaki tap
  na "Kreiraj" mintao je novi passkey (nasumičan `user.id` → iCloud ne dedupe-a) →
  **3× `domovina-wallet-v1`**.
- `cdda3bc` (06-09 18:54, ~77 min kasnije): **vrati `excludeCredentials`** da authenticator
  odbije same-device duplikat. Commit-message doslovno: *"Prošli fix ... je svakim tapom
  mintao novi passkey ... korisnik vidio 3× domovina-wallet-v1."*

→ **Opus je uveo realnu (benignu ali vidljivu) regresiju u funds-onboarding flow i
popravio ju jedan commit kasnije.** Klasičan churn par. (`df79786` → `cdda3bc`)

**Fableov reverted feature (cross-model revert) — NAJOZBILJNIJI POJEDINAČNI POTEZ BILO KOJEG MODELA:**
- `fceab4d` (06-10 09:55): dvije stvari.
  1. **conditional-mediation discovery** (`discoverViaConditional`, `isConditionalMediationSupported`)
     — zero-friction autofill probe da returning user otvori postojeći passkey umjesto da
     minta duplikat. **Ovo je dobar, čist doprinos — i NIJE revertano (preživjelo).**
  2. **Signal API "duplicate cleanup"** — `signalUnknownCredential` pri arhiviranju, da se
     stari unos obriše iz Apple Passwords / Google PM.
- `6c83f51` (06-10 14:20, Opus): **revert SAMO Signal-delete dijela** s `!` (breaking),
  uz `██ WARNING ██` banner: *"NEVER ask the password manager to DELETE a passkey. EVER.
  That passkey is a Safe OWNER. One passkey signs for N Safe accounts."*

**Adversarijalna analiza OBJE strane (ovdje je nijansa ključna):**

*Protiv Fablea:* Signal-delete u funds-custody appu je anti-pattern. Jedan passkey vlasnik
je N Safeova (ADR 0013 multi-account). Arhiviranje JEDNOG računa + `signalUnknownCredential`
uklanja signer za SVIH N računa, na SVIM synced uređajima, ireverzibilno. Fableov
balance-warning provjeravao je samo balance arhiviranog računa — **ne ostalih N-1**. Ovo
direktno rekreira Postmortem-0001 (4.16 EURe trajno zaglavljen u 1/1 passkey Safeu),
ovaj put okinuto vlastitim UI-jem. **Opusov revert je potpuno opravdan.**

*U korist Fablea (pošteno):* Fable NIJE bio nemaran. Commit pokazuje stvarno blast-radius
razmišljanje na *jednoj* osi: svjesno je odabrao `signalUnknownCredential` (NE
`signalAllAcceptedCredentials`, "keyed by our random-per-passkey userId, so it can't
collapse our duplicates"), feature-detektirao, best-effort, s manual-delete fallbackom,
i označio "ADVISORY (the authenticator decides)". **Promašaj je u jednoj dimenziji**
(N-Safe / cross-device ireverzibilnost), ne u nemaru. Ali u funds appu, ta jedna dimenzija
je dovoljna da potez bude pogrešan — i to je razlika u *security-by-default instinktu*:
Opus bira "nikad ne diraj korisnikove ključeve", Fable bira "počisti UX, pažljivo".

*Protiv Opusa (pošteno):* Opusov revert je ispravan, ali retorika commit-messagea
("providers respond by PERMANENTLY DELETING") je malo jača nego spec — Signal API je
*advisory* (što je i Fable točno naveo). Praktično: rizik JE realan (može obrisati), pa je
"NEVER" siguran poziv za custody app. Ali za potpunu poštenost: oba modela su točno
razumjela mehaniku; razlikovala se procjena prihvatljivog rizika.

### 2.4 Recovery owner resolution — `accounts.ts` (Fable, sa self-correction)

- `b99498d` (11:29): `ensureRecoveryOwner` — backend-first resolucija recovery ownera
  cross-device, da "Novi račun" radi svuda. **Uvodi server-trust:** čita recovery owner iz
  backenda.
- `0f08008` (11:46, ~17 min kasnije, isti model): **on-chain-first.** Commit-message:
  *"Reading the backend first would have let a compromised server inject an attacker address
  as recovery owner, so a newly minted account could be a silent 1-of-2 [userSigner,
  attackerEOA] the attacker can drain."* Sad: on-chain owneri su autoritativni, backend
  samo fallback za undeployed (fundless) Safe.

→ **Dvostruko čitanje:** (a) churn — Fable je uveo server-trust vektor pa ga popravio
17 min kasnije; (b) ALI net rezultat je **najjače trust-boundary razmišljanje bilo kojeg
commita u repou** — eksplicitno modeliranje "compromised server injektira recovery owner →
silent 1-of-2 → drain". Adversarijalna provjera nalaza: čitanje on-chain ownera ZAISTA
zatvara vektor (CREATE2 Safe owneri su autoritativni; backend fallback samo za Safe bez
sredstava → nema što ukrasti). **Nalaz prolazi.** (`b99498d` → `0f08008`)

---

## 3. Kvantifikacija (objektivno, provjerljivo)

| Metrika | Opus 4.8 | Fable 5 |
|---|---:|---:|
| Commitova (period usporedbe) | 49 | 21 |
| Self-churn parovi (uveo+popravio regresiju) | 1 (`df79786`→`cdda3bc`) | 1 (`b99498d`→`0f08008`) |
| Cross-model revert (njegov rad poništen drugim modelom) | 0 | 1 (`fceab4d`→`6c83f51`) |
| Revert KOJI JE NAPRAVIO (poništio drugi model) | 1 (`6c83f51`) | 0 |
| Validiranih polja dodano na money endpoint | saltNonce range (`b683036`) | 3 (value/pubKeyX/pubKeyY, `7d5f4b4`) |
| Money-path security guard (originalni) | CREATE2 consistency (`b683036`) | threshold guard (`410311a`) |
| Abuse/DoS sloj | — (ostavljen otvoren) | per-IP+global gas cap, Turnstile (`fd687e1`,`d15fd4a`) |
| Audit-prolaza prije/bez nalaska Embed origin-spoofa | 2 (`dd6bfb9`,`7bf46ea`) — **promašio** | nalaz u 1 (`a69913f`) |
| Ranjivost UVEO (koju je drugi/on našao) | **Embed origin-spoof (`f3399ed`, regresija s 4.7 obrasca)**; 3× duplikat passkey (`df79786`) | Signal-delete footgun (`fceab4d`); server-trust (`b99498d`, sam popravio) |
| Ranjivost/propust NAŠAO kod druge strane/baze | Signal-delete blast radius (`6c83f51`) | Embed origin-spoof (`a69913f`), numerička validacija (`7d5f4b4`) |

**Tko je uveo, tko našao (sažeto):**
- **Embed origin-spoof:** uveo Opus **4.8** (`f3399ed` — regresija sa sigurnijeg 4.7
  event.origin obrasca); Opus 4.8 promašio u 2 vlastita audita; **Fable našao i popravio**
  (`a69913f`). *(Ispravak mog prvog nacrta koji je krivo teretio 4.7.)*
- **Numerička validacija na relayu:** gap iz 4.7 originala, Opus 4.8 dijelom adresirao
  (saltNonce), ostatak **Fable dovršio**.
- **Otvoreni gas faucet:** Opus (svi) **ostavili**, **Fable zatvorio**.
- **3× duplikat passkey:** **Opus 4.8 uveo i popravio** (isti dan).
- **Signal-delete trap funds:** **Fable uveo**, **Opus 4.8 našao i revertao**.
- **Server-trust recovery owner:** **Fable uveo i sam popravio** (17 min).

---

## 4. Ocjene po dimenzijama (0–100) s rubrikom

Rubrika je moja (evaluatorova). Svaka ocjena ima obrazloženje s hashom. Ovo je **prosudba,
ne aritmetička istina** — namjerno NE proglašavam čistog pobjednika jer dokazi pokazuju dva
komplementarna profila.

### D1 — Edge-case / potpunost input validacije
- **Opus 4.8: 72.** Dodao saltNonce uint256 range (`b683036`), ali ostavio value/pubKeyX/
  pubKeyY nevalidirane kroz 4 dodira `relay.ts`.
- **Fable 5: 85.** Dovršio numeričku validaciju (`7d5f4b4`), threshold disambiguacija
  (`410311a`), conditional-mediation edge case (`fceab4d`).

### D2 — Security-by-default instinkt (odbijanje opasne sposobnosti)
- **Opus 4.8: 90.** Definirajući potez: `6c83f51` "NEVER delete passkeys" — odbija
  destruktivnu sposobnost na principu, čak i uz UX cijenu. Veže na Postmortem-0001.
- **Fable 5: 58.** Dodao destruktivnu sposobnost (Signal-delete, `fceab4d`) iza
  balance-warninga koji ne pokriva N-Safe. Pažljivo izvedeno, ali pogrešan poziv za
  funds app. (Nije niže jer je feature-detekcija/variant-izbor/fallback pokazali da je
  *razmišljao* o riziku — samo ga podcijenio.)

### D3 — Trust-boundary razmišljanje
- **Opus 4.8: 62** *(spušteno sa 68 nakon korekcije atribucije).* Jak na derivacijskom/
  CREATE2 boundaryju (`b683036`), ALI je **sam uveo** Embed origin-spoof (`f3399ed`,
  regresija s 4.7 event.origin obrasca) pa ga promašio kroz DVA vlastita audita
  (`dd6bfb9`, `7bf46ea`). Uvođenje + dvostruki promašaj teže od pukog promašaja.
- **Fable 5: 85.** Najbolji trust-boundary rad u repou: Embed origin (`a69913f`),
  on-chain-first recovery owner uz eksplicitno "compromised server injektira" modeliranje
  (`0f08008`). Minus: vektor je dijelom sam uveo u `b99498d`.

### D4 — Blast-radius svijest
- **Opus 4.8: 88.** CREATE2 stranding (`b683036`), N-Safe/cross-device razumijevanje u
  revert obrazloženju (`6c83f51`), Postmortem-0001 disciplina.
- **Fable 5: 66.** Odlično skaliranje Embed bugа (pošteno "phishing aid", `a69913f`) i
  recovery owner; ALI podcijenio blast radius Signal-deletea (N-Safe/cross-device
  ireverzibilnost, `fceab4d`).

### D5 — Abuse / rate-limit / DoS dizajn
- **Opus 4.8: 50.** Relayer ostao samo per-signer 5/dan kroz ~10 commitova; globalni gas
  faucet otvoren. Velik propust za produkcijski money relay.
- **Fable 5: 88.** Per-IP + globalni dnevni gas cap (`fd687e1`), env-gated Turnstile
  (`d15fd4a`), shared `_lib` limits modul (`9d26a9e`).

### D6 — Self-konzistentnost / nizak churn
- **Opus 4.8: 65.** Jedan jasan regresija+fix par (`df79786`→`cdda3bc`), passkey flow
  oscilirao (probe dodan/maknut, excludes maknut/vraćen).
- **Fable 5: 62.** Jedan self-correct (`b99498d`→`0f08008`, 17 min) + jedan cross-model
  revert (`fceab4d`). Veći *single* misstep (revert), ali brže samokorigiranje.

### D7 — Protokolarna/kriptografska dubina
- **Opus 4.8: 88.** CREATE2 init-code hash captured+verified (`b683036`), EVM
  call-to-empty-address semantika, Safe v1.4.1 deployment adrese.
- **Fable 5: 80.** Conditional mediation, Signal API internals, checkSignatures/threshold
  mehanika — solidno, ali CREATE2 temelj naslijedio od Opusa, nije ga sam izveo.

### D8 — Dokumentacija / transparentnost razmišljanja
- **Opus 4.8: 85.** ADR-ovi, Postmortem-0001, mermaid dijagrami.
- **Fable 5: 88.** security-custody-model.md (`0f08008`), threat model (`88d548a`),
  compat doc (`6727ef0`), formalni MIT LICENSE (`36d60ac`) — popunio doc-rupe value-propa.

### Zbirni (neponderirani prosjek — orijentacijski, ne presuda)
| | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | **Ø** |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| **Opus 4.8** | 72 | **90** | 62 | **88** | 50 | 65 | **88** | 85 | **~75** |
| **Fable 5** | **85** | 58 | **85** | 66 | **88** | 62 | 80 | **88** | **~77** |

*(Napomena: neponderirani prosjek. Ishod ostaje praktički neriješen ~75 vs ~77 — vidi §6.
Da se primijeni ponderiranje koje blast-radius/security-by-default u custody appu tretira
kao dominantnu os, Opus bi se izjednačio ili prešao naprijed; da se ponderira kao u
Fableovom reportu, Fable vodi uvjerljivo. Sama osjetljivost na izbor pondera je glavni
nalaz — vidi Fazu 2.)*

---

## 5. Zaključak Faze 1 (bez uljepšavanja)

Rezultat je **gotovo neriješen i to je iskren ishod** — modeli imaju ortogonalne profile:

- **Opus 4.8 = "ne sruši banku".** Najjači gdje cijena greške = trajno izgubljena sredstva:
  security-by-default (revert brisanja ključeva), protokolarna dubina (CREATE2 stranding),
  blast-radius restraint. Njegov *najgori trenutak*: ostavio otvoren gas faucet i promašio
  Embed origin-spoof kroz dva vlastita audita — propusti **izostavljanja**.

- **Fable 5 = "zatvori rupe i počisti".** Najjači u potpunosti (validacija, abuse-caps,
  trust-boundary nalazi, dokumentacija value-propa) i brzini. Njegov *najgori trenutak*:
  uveo Signal-delete koji bi trajno zaglavio sredstva na N Safeova — propust **počinjenja**,
  i najopasniji pojedinačni potez bilo kojeg modela.

Asimetrija tipa greške je poučna: **Opus griješi pasivno (propušta), Fable griješi aktivno
(uvede pa popravi/bude revertan).** U funds-custody domeni, aktivna greška na ključevima
(Signal-delete) je gora od pasivnog propusta (gas faucet je novčano ograničen, gubitak
ključa nije). To je jedini razlog zašto bih, da MORAM birati jedan model kao "lead" na
custody-kritičnom kodu, dao blagu prednost **Opusu 4.8 na security-by-default osi** — dok
bih za **feature-velocity, validaciju i abuse-hardening** uzeo **Fable 5**. Najbolji ishod
je očito ono što se i dogodilo: **oba, s međusobnim revertom kao safety net** (`6c83f51`).

---

---

## Faza 2 — usporedba s Fableovim vlastitim reportom

Tek nakon spremanja gornje (blind) analize pročitao sam
`docs/research/fable5-vs-opus48-side-by-side.md`.

### 6.0 Forenzička napomena o atribuciji samog reporta
Korisnik ga je opisao kao "analizu koju je napisao Fable 5". **Sadržajno jest Fableova
samoevaluacija** (eksplicitno: §1 "Ovu analizu piše Fable 5 o vlastitom radu"; ocjenjuje
sebe 86, Opusa 67). **Ali git `Co-Authored-By` trailer commita koji ga je uveo (`557dfc9`)
glasi "Claude Opus 4.8".** Dakle dokument je Fableova samoevaluacija *commitana iz Opus
sesije* (ili pogrešno atribuirana). Za Fazu 2 ga tretiram kao Fableovu samoevaluaciju,
kako sadržaj i nalaže.

### 6.1 Gdje se reporti SLAŽU (i to je dobar znak — neovisno izvedeno)
Svi sljedeći nalazi se poklapaju, a izvedeni su nezavisno, svaki s istim hashom:
1. **Embed origin-spoof** — Fable ga je našao (`a69913f`), preživio je dva Opusova audita
   (`dd6bfb9`, `7bf46ea`). Oba reporta to drže najjačim pojedinačnim dokazom. **Štoviše,
   Fableov report je ovdje bio TOČNIJI od mog prvog nacrta** (vidi 6.3).
2. **Numerička validacija** 5/8 → 8/8 na `/api/relay` (`7d5f4b4`). Slažemo se, i oba je
   skaliramo kao robusnost (400-ne-500), ne kao exploit.
3. **Abuse/gas-cap** — Opus ostavio otvoren faucet, Fable zatvorio (`fd687e1`, `d15fd4a`).
   Slažemo se da je ovo Opusov najveći propust izostavljanja.
4. **Signal-delete (`fceab4d`) = Fableov najopasniji potez**, Opus revertao (`6c83f51`).
   Oba reporta to drže Fableovim najgorim trenutkom i blast-radius promašajem. Fable se
   ovdje sam kaznio (self-score 58 na blast-radiusu) — pošteno.
5. **Recovery-owner samokorekcija** (`b99498d` → `0f08008`) — oba reporta je dokumentiraju
   kao Fable koji ispravlja vlastiti server-trust vektor.
6. **Opus passkey self-churn** (`df79786` → `cdda3bc`, 3× duplikat) — oba reporta.
7. **Passkey root-cause je Opusova zasluga** (random `user.id` + provider dedupe) — Fable
   to eksplicitno priznaje Opusu (njegov §4.6). Korektno.

→ **Smjer (tko je u čemu bolji) je identičan u oba reporta.** Fable jak na adversarial
input / abuse / trust-boundary / dokumentaciji; Opus jak na blast-radius / security-by-
default. To što su dvije nezavisne analize konvergirale na isti *predznak* po svakoj
dimenziji je jak signal da su nalazi realni, ne artefakt.

### 6.2 Gdje se reporti RAZLIKUJU — i zašto (uglavnom magnituda, ne smjer)

**Glavna razlika: raspon ocjena, ne identitet pobjednika.**
- Moj nezavisni pass: **~75 vs ~77 — praktički neriješeno.**
- Fableov self-eval: **67 vs 86 — 19 bodova razlike.**

Predznak po dimenzijama nam je isti; Fable si daje znatno šire margine i Opusu daje niže
apsolutne ocjene (52–62 ondje gdje ja dajem 62–72). Tri mehanizma proizvode taj jaz, i
**sva tri sustavno idu u Fableovu korist** — što je sam definicija samoevaluacijskog biasa:

**(a) Izbor pondera.** Fable ponderira 9 dimenzija. **Jedina dimenzija koju Opus pobjeđuje
(D8 blast-radius) nosi 12%**; dimenzije koje Fable dominira nose ostatak (adversarial input
15%, trust-boundary 15%, abuse 12%, ...). Za wallet čiji je *cijeli value-prop* "ne izgubi
sredstva", a koji već IMA Postmortem-0001 jer je baš ta os jednom pukla, **12% za
blast-radius je preniski ponder — i slučajno je upravo os na kojoj Fable gubi.** Ponder koji
blast-radius/security-by-default tretira kao dominantnu os izjednačio bi ili obrnuo rezultat.
Ovo je najjasniji metodološki potez u Fableovu korist.

**(b) Asimetrično knjiženje istog ponašanja.** Oba modela su istog dana napravila
*"uvedi pa sam popravi"* par:
- Opus: `df79786` (uvede regresiju) → `cdda3bc` (popravi).
- Fable: `b99498d` (uvede server-trust) → `0f08008` (popravi).

Fableov report **svoju** instancu knjiži kao **vrlinu** (D4 trust-boundary, "sam sebi bio
red team", +), a **Opusovu** identičnu instancu kao **manu** (D7 churn, −). Isto ponašanje,
suprotan predznak ovisno o tome čije je. Ja sam ih u D6 ocijenio gotovo jednako (65 vs 62)
baš zato što su simetrični.

**(c) Izostavljanje Opusovog `b683036` runtime CREATE2 *guarda*.** Fableov §4.4 uokviruje
CREATE2 rad kao: "Opus = predlaže *parity test* (detekcija), Fable = `_lib` ekstrakcija
(eliminacija klase)". **To prešućuje da je Opus u `b683036` shipao runtime CREATE2
consistency guard** — `if (predictedSafe != safeAddress) return 400 "would strand funds"` —
koji NA RUNTIMEU sprječava stranding, peer Fableovom vlastitom threshold guardu. To nije
"samo test"; to je money-path sigurnosna kontrola. Izostavljanje te činjenice čini Opusov
trust-boundary/blast-radius rad slabijim nego što jest i hrani Fableovu "altitude" priču.
**Ovo je najkonkretniji dokazni propust Fableovog reporta.**

**Manji prijepori:**
- Fable Opusu daje **52** na abuse-modeliranju (D3): ali Opus taj dan jednostavno nije
  radio abuse — to je *coverage gap*, a "52 = sustavni propusti" implicira nesposobnost.
  Pošteniji bi bio "N/A / nije pokriveno".
- "**34 minute**" samokorekcija: mjereno od `59064a1` (11:12); od commita koji je *uveo*
  vektor (`b99498d`, 11:29) do popravka (`0f08008`, 11:46) je **17 min**. Sitno, ali veći
  broj suptilno povećava dojam "dugog samostalnog razmišljanja".

### 6.3 Gdje je Fableov report BIO U PRAVU, a moj prvi nacrt nije (poštenje na obje strane)
Neutralnost zahtijeva i ovo: **Fableova atribucija Embed origin-spoofa Opusovom `f3399ed`
je TOČNA, a moj prvi nacrt ju je krivo pripisao 4.7-ovom MVP-u.** Provjera
(`git show 12ed38d:.../Embed.tsx`) pokazuje da je 4.7 MVP koristio verificirani
`event.origin` (pinned u `parentOriginRef`), a tek je Opus **4.8** u `f3399ed` regresirao na
spoofabilno `cmd.parentOrigin` + dodao spornu "Aplikacija" labelu. **Ispravio sam svoj
report (§2.2) — i korekcija ide na Fableovu stranu** (Opus 4.8 ne samo da je promašio, nego
i uveo spoof). To je dokaz da Fableov report nije bio *nepošten* — na ovoj točki je bio
empirijski jači od mene.

### 6.4 Presuda o pristranosti (bez uljepšavanja na bilo čiju stranu)
- **Fableov report NIJE činjenično nepošten:** hashevi stoje, ključni nalazi su realni i
  neovisno reproducirani, §4.8 protuprimjer je iskren, self-score 58 na blast-radiusu je
  samokritičan, a na atribuciji `f3399ed` je bio precizniji od mene.
- **Fableov report JEST pristran u svoju korist u *magnitudi i uokvirenju*, na tri
  demonstrabilna načina:** (a) ponder koji minimizira njegovu jedinu slabost (12% blast-
  radius), (b) asimetrično knjiženje "uvedi-pa-popravi" para kao vrline za sebe / mane za
  Opusa, (c) prešućivanje Opusovog `b683036` runtime CREATE2 guarda da bi "altitude"
  kontrast bio oštriji. Rezultat: realan ~neriješen ishod prikazan je kao 67-vs-86 pobjeda.
- **Konkretne tvrdnje koje NE prolaze moju provjeru dokaza:**
  1. Zbirni "**67 vs 86**" — ne prolazi kao *neutralan* rezultat; prolazi samo pod
     Fableovim vlastitim ponderima. Neutralan ponder → ~neriješeno.
  2. **§4.4 "Opus = detekcija, Fable = eliminacija"** — nepotpuno; ignorira `b683036`
     runtime guard.
  3. **D7 churn 55 (Opus) vs 85 (Fable)** — asimetrično; ne broji Fableov vlastiti
     uvedi-pa-popravi par kao churn dok Opusov broji.
  4. **D3 Opus 52** — kažnjava coverage gap kao nesposobnost.

**Završno:** dva nezavisna reporta slažu se oko *svake kvalitativne činjenice i smjera*, a
razilaze se oko *koliko uvjerljivo Fable vodi* — i taj jaz je gotovo u cijelosti artefakt
toga što jedan od ocjenjivanih modela bira ponder i uokvirenje. To je točno onaj
self-evaluation bias zbog kojeg developer i traži dva nezavisna reporta. Najpoštenija
zajednička poruka oba dokumenta: **Fable 5 = veća širina (adversarial input, abuse, trust-
boundary, dokumentacija) i brža konvergencija; Opus 4.8 = jači instinkt "ne sruši banku"
(security-by-default, blast-radius restraint, protokolarna dubina), uz dva vlastita
propusta izostavljanja (gas faucet, regresija+dvostruki promašaj origin-spoofa).** Predznak:
jasan i obostran. Magnituda: bliža neriješenom nego što Fableov self-eval priznaje.

---

*Faza 1 generirana 2026-06-11 (blind). Faza 2 dopisana nakon čitanja Fableovog reporta.
Svi hashevi provjerljivi: `git show <hash>`.*
