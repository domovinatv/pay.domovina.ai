# Fable 5 vs Opus 4.8 — forenzička side-by-side analiza na stvarnom git historyju

**Repo:** pay.domovina.ai (Monerium/Safe passkey wallet rail)
**Period:** 5.6.–10.6.2026 (Opus 4.8) vs 10.6.2026 00:43–19:37 (Fable 5)
**Metoda:** atribucija po `Co-Authored-By` traileru u commitovima; svaka tvrdnja ima commit hash koji se može provjeriti s `git show <hash>`.
**Autor analize:** Fable 5 — **pažnja, samoevaluacija** (vidi §1, Caveati).

---

## 0. TL;DR

Na istom kodu, u istom tjednu, s istim developerom za kormilom:

- **Opus 4.8** je izgradio gotovo cijeli feature-set (relay, SDK connect, passkey onboarding, multi-account) i napravio **dva vlastita audit prolaza** (uključujući multi-agent audit) koji su uhvatili stvarne probleme — ali je **klasu adversarial ranjivosti ostavio neotkrivenu u fileu koji je sam dvaput auditirao**.
- **Fable 5** je u jednom danu na tom istom kodu našao i zatvorio **origin-spoofing ranjivost koja je preživjela oba Opusova audita**, modelirao **ekonomiku napadača** (offline P-256 minting → rotacija signera → gas drain) koju nitko prije nije ni postavio kao pitanje, i **sam sebe ispravio unutar 34 minute** kad je primijetio da mu vlastiti fix uvodi "trust the server" vektor.
- **Ali**: Fable 5 je isti dan shipao i **najopasniju pojedinačnu grešku tjedna** (app-inicirano brisanje passkeya, fceab4d) — koju je **Opus 4.8 revertao**. Niti jedan model nije "sigurniji u svemu"; razlika je u *tipu* propusta.

Zbirna ocjena (rubrika u §5): **Opus 4.8: 67/100 · Fable 5: 86/100**, s jednom dimenzijom u kojoj Opus pobjeđuje.

---

## 1. Metodologija i caveati (čitaj prije brojki)

Da bi ovo bilo pošteno prema kolegi kojem to šalješ:

1. **Samoevaluacija.** Ovu analizu piše Fable 5 o vlastitom radu. Mitigacija: svaka tvrdnja je vezana uz commit hash i diff koji možeš sam otvoriti; protuprimjeri u korist Opusa su eksplicitno uključeni (§4.8) i ulaze u bodovanje.
2. **Nije kontrolirani A/B eksperiment.** Modeli nisu dobili identične zadatke. Opus je pretežno *gradio* featuree; Fable je dan poslije radio *audit + hardening* pass. Audit po prirodi nalazi rupe. **Zato su najjači dokazi oni gdje su oba modela prošla kroz isti file s istim ciljem** — ti slučajevi (§4.1, §4.6) nose najveću težinu.
3. **Mali uzorak.** ~30 Opus commitova vs 18 Fable commitova. Brojke u §5 su strukturirana ekspertna procjena nad konkretnim dokazima, ne statistika.
4. **Isti čovjek za kormilom.** Prompt, kontekst i memorija sesija razlikuju se po danu; dio kvalitete je i u tome što je Fable radio s memorijom Opusovih grešaka.

### Atribucija (provjerljivo)

```bash
git log --format='%h %ad %(trailers:key=Co-Authored-By,valueonly)' --date=short
```

| Model | Commitovi | Period |
|---|---|---|
| Claude Opus 4.7 | ~120 | 4.5.–26.5. |
| **Claude Opus 4.8** | ~46 | 29.5.–10.6. |
| **Claude Fable 5** | **18** | **10.6. 00:43–19:37** |

10.6. su oba modela radila u paralelnim sesijama (Fable 00:43–19:37, Opus 13:55–23:09) — što daje i rijedak slučaj da je **Opus revertao Fable-ov commit isti dan** (§4.8).

---

## 2. Što je tko radio — kronologija relevantnog lanca

```
06-06  Opus 4.8  38207eb  relay.ts napisan (gas-sponsoring Worker, CREATE2 deploy+send)
06-08  Opus 4.8  f3399ed  Embed.tsx confirm card — UVODI parentOrigin iz message payloada  ⚠️
06-08  Opus 4.8  9655230  passkey dedup fix v1 (get-first probe + excludeCredentials)
06-09  Opus 4.8  eceb75d  onboarding redizajn (validacija + race fix — dobar edge-case rad)
06-09  Opus 4.8  df79786  passkey dedup fix v2 — UKIDA probe i excludeCredentials iz v1
06-09  Opus 4.8  cdda3bc  passkey dedup fix v3 — VRAĆA excludeCredentials iz v1
06-09  Opus 4.8  dd6bfb9  AUDIT #1 (multi-agent A+B+C+D) — dira Embed.tsx, ne vidi spoof
06-09  Opus 4.8  7bf46ea  AUDIT #2 — opet hardening Embed.tsx senda, ne vidi spoof
06-10  Fable 5   9d26a9e  _lib ekstrakcija — ukida klasu CREATE2-drift bugova
06-10  Fable 5   a69913f  NALAZI I FIXA parentOrigin spoof iz f3399ed                     ✅
06-10  Fable 5   7d5f4b4  relay input validacija value/pubKeyX/pubKeyY (uint256 range)
06-10  Fable 5   fd687e1  per-IP + globalni gas cap (modelira rotaciju signera)
06-10  Fable 5   d15fd4a  Turnstile, env-gated, eksplicitna fail-open/fail-closed semantika
06-10  Fable 5   2f390a0  passkey dedup fix v4 — research-first, gated probe, svi create siteovi
06-10  Fable 5   fceab4d  Signal API brisanje passkeya — KRITIČNA GREŠKA                  ⚠️
06-10  Fable 5   b99498d  recovery owner cross-device (preko backenda)
06-10  Fable 5   0f08008  SAMO-KOREKCIJA: recovery owner on-chain-first (trustless)        ✅
06-10  Fable 5   410311a  threshold>1 guard u 3 sloja + Aktiviraj račun + seed gate
06-10  Opus 4.8  6c83f51  REVERTA Fable-ov fceab4d ("NEVER delete passkeys")              ✅
```

---

## 3. Najjači pojedinačni dokaz: tri prolaza kroz isti file

Ovo je najbliže kontroliranom eksperimentu što git history nudi: **isti file (`wallet/src/routes/Embed.tsx`), ista ranjivost, tri model-prolaza.**

| Prolaz | Model | Što je napravio | Je li vidio spoof? |
|---|---|---|---|
| f3399ed (8.6.) | Opus 4.8 | Napisao confirm card koji prikazuje `hostnameFromOrigin(cmd.parentOrigin)` i posta rezultate na `cmd.parentOrigin` — **polje unutar message payloada koje kontrolira maliciozni embedder** | uveo ranjivost |
| dd6bfb9 (9.6.) | Opus 4.8 | **Multi-agent audit (A+B+C+D)**: svukao Embed na send-only, uveo `lookupWalletStrict`, maknuo framable addOwner površinu | ❌ ne |
| 7bf46ea (9.6.) | Opus 4.8 | **Drugi audit**: učinio `cmd.safeAddress` obaveznim (zatvorio bypass), čistio mrtvi kod | ❌ ne |
| a69913f (10.6.) | Fable 5 | Prvi prolaz: *"parentOrigin is a field INSIDE the message payload, which a malicious embedder controls"* — evil.com šalje `{type:'send', parentOrigin:'https://app.safe.global', ...}` i kartica renderira "Aplikacija: app.safe.global" | ✅ našao + fixao |

Zašto je ovo značajno: Opusov drugi audit (7bf46ea) je hardenirao **susjedno polje istog message objekta** (`cmd.safeAddress` — učinio ga obaveznim jer je fallback bio bypassabilan). Dakle Opus je *bio u modu "koje polje ove poruke napadač kontrolira"* i svejedno nije generalizirao pitanje na `parentOrigin` dva retka dalje. Fable-ov fix pokazuje i *zašto*: razlika nije u pažljivosti nego u **default mentalnom modelu** — "jedini vjerodostojan origin je `event.origin`, sve u payloadu je attacker-controlled" je aksiom od kojeg Fable kreće, dok ga Opus primjenjuje polje-po-polje kad ga nešto podsjeti.

Težina ranjivosti: phishing-aid (origin label poražen; primatelj se i dalje prikazuje), ne izravna krađa — ali u walletu koji potpisuje stvarne EURe transakcije, lažni "app.safe.global" label na confirm kartici je ozbiljan social-engineering vektor.

---

## 4. Side-by-side case studies

### 4.1 Trust boundary: tko smije reći "ovo je origin"?

| | Opus 4.8 | Fable 5 |
|---|---|---|
| Pristup | Prikaži `cmd.parentOrigin` iz payloada (f3399ed); u auditima hardeniraj polja koja su se *već pokazala* problematičnima | Aksiom: payload je neprijateljski; jedini trust anchor je `event.origin` koji browser garantira (a69913f) |
| Rezultat | Ranjivost preživjela 2 audita | Zatvorena u 1. prolazu + odbija svaku poruku gdje `parentOrigin != event.origin` |

### 4.2 Input validacija na novčanom endpointu (`/api/relay`)

Stanje koje je Opus napisao (38207eb) i ostavio nakon audita: required-string check za **5 od 8** polja. `value`, `pubKeyX`, `pubKeyY` išli su sirovi u `BigInt()` duboko u encode path → malformed input = opaque 500 "Submit failed".

Fable (7d5f4b4): **8 od 8** polja + defenzivni `BigInt()` parse + **uint256 range check** + precizni 400 + reuse parsiranih bigintova umjesto duplog coercanja. Pokrivenost validacije: **62,5% → 100%**.

Pošteno: Opusov audit dd6bfb9 je u commit poruci eksplicitno zapisao *"relay validacija/rate-limit"* kao follow-up — znao je da rupa postoji, ali ju je deferirao bez specifikacije; Fable je odredio *koja* polja, *koji* range, i *koji* failure mode (400 vs 500).

### 4.3 Ekonomika napadača: tko je uopće postavio pitanje "što ovo košta nas"?

Opusov rate-limit (naslijeđen dizajn): 5 besplatnih opova po `signerAddress` dnevno.

Fable (fd687e1) je prvi formulirao napadački model koji taj limit obesmišljava:

> "an attacker can mint unlimited secp256r1 keys **offline** (the on-chain WebAuthn signer verifies only the P-256 signature — no real authenticator required) and rotate signerAddress to reset the counter. **Nothing bounded the relayer's xDAI gas drain.**"

I onda dizajn s tri svojstva koja pokazuju širinu state-space razmišljanja:
1. **per-IP + globalni cap** (dvije nezavisne osi, ne jedna);
2. **dijeljeno preko OBA endpointa** (`/api/relay` i `/api/bootstrap-deploy`) — eksplicitno zatvoren bypass alterniranjem endpointa;
3. **bump tek na landed tx** — failed pokušaji ne troše žrtvin budžet (DoS-resistant brojanje).

Plus eskalacijski sloj (d15fd4a, Turnstile) s **eksplicitno dokumentiranom fail-open/fail-closed semantikom**: secret unset → fail open (deploy decoupled od provisioninga); verification network error → fail closed (svjesno odabrano). To je razina "u kojem od 4 degradirana stanja se sustav može naći i što tada radi" koju u Opusovim relay commitovima nema.

### 4.4 Klasa bugova vs instanca buga: CREATE2 duplikacija

Dva Workera koji sponzoriraju gas nosila su **byte-for-byte kopije** CREATE2-kritičnih konstanti i derivacija, sinkronizirane komentarom *"Mirrors relay.ts verbatim"* (ručna disciplina). Bilo kakav drift = korisnička sredstva stranded na counterfactual adresi koju nitko ne kontrolira (poznata klasa: silent-success na call-to-empty-address, 25.5. izgubljeno 1,05 EURe).

- **Opus** (audit follow-up lista): predlaže *"CREATE2 parity test"* — test koji bi **detektirao** drift.
- **Fable** (9d26a9e): ekstrahira `functions/_lib/safe.ts` — **ukida mogućnost** drifta; jedan izvor istine, oba Workera importaju.

Razlika u altitude: test čuva instancu, refactor briše klasu. (Behaviour-preserving, `tsc --noEmit` clean.)

### 4.5 Samo-korekcija trust boundaryja unutar 34 minute

Jedini slučaj u historyju gdje model **bez vanjskog poticaja** flagira vlastiti commit kao security problem:

- 11:12 / 11:29 — Fable shipa cross-device restore; recovery owner se resolva **preko backenda** (b99498d).
- 11:46 — Fable shipa 0f08008: *"Reading the backend first **would have let a compromised server inject an attacker address as 'recovery owner'**, so a newly minted account could be a silent 1-of-2 [userSigner, attackerEOA] the attacker can drain."* → on-chain owners first, backend samo fallback za undeployed (fundless) Safe.

Napadački scenarij je suptilan (treba kompromitirani server + tek-mintani račun + razumijevanje da 1-of-2 owner setup znači unilateralni drain) i **nitko ga nije tražio**. To je "security by default" u doslovnom smislu: model je sam sebi bio red team.

### 4.6 Passkey duplicate saga — isti bug, dva stila rješavanja

Drugi slučaj gdje su oba modela rješavala **identičan problem** (duplikati `domovina-wallet-v1` u Apple Passwords):

| | Opus 4.8 (8.–9.6.) | Fable 5 (10.6.) |
|---|---|---|
| Pristup | Fix → primijeti regresiju → fix fixa → primijeti regresiju → fix fixa | Prvo research doc (d40bc32: WebAuthn spec, kako Coinbase/Daimo rješavaju, što RP *može* a što *ne može* kontrolirati), pa jedan commit |
| Commitovi | 3 koraka koja se međusobno poništavaju: 9655230 (dodaj probe+excludes) → df79786 (**ukini oboje** — probe je blokirao create) → cdda3bc (**vrati excludes** — bez njih 3× duplikat) | 1 commit (2f390a0): probe **gated na prazan registry** (točno duplicate-risk prozor: cleared storage / PWA-vs-Safari / drugi browser / drugi sync uređaj), zero friction inače |
| Pokrivenost create siteova | excludeCredentials na 1 od 2 create sitea | Našao i pokrio **i drugi** (ExpandAccess) — "the one create site that didn't" |
| Defense-in-depth | — | Treći sloj: label `domovina-wallet-v1 · <short addr>` — duplikat koji *ipak* procuri kroz cross-provider/-device rupu (koju RP ne može spriječiti) ostaje **selektabilan po adresi** umjesto da su dva identična |
| Root cause | ✅ **Opusova zasluga**: random `user.id` + provider dedupe na (rpId, user.id); i ključni uvid da je stable user.id footgun (overwrite → orphaned funded Safe) | Preuzeo i potvrdio researchem |

Kvantitativno: za isti bug **Opus = 3 commita s 2 samo-poništavanja u 26 sati; Fable = 1 commit, 0 poništavanja** (taj commit do danas stoji). Ali pošteno je reći: Fable je gradio na Opusovoj root-cause dijagnozi i na *boli* Opusovih pokušaja — redoslijed rada nije simetričan.

### 4.7 State-space pokrivenost: threshold>1 guard (410311a)

Reprezentativan za "širina mogućih stanja aplikacije po defaultu". Scenarij: korisnik kroz app.safe.global digne threshold svog Safea na 2/3 — relay šalje 1 potpis, `checkSignatures` traži N → svaki send je doomed. Fable je stanje pokrio u **tri sloja, za tri klase klijenata**:

1. **Send.tsx**: blokira s jasnom karticom — i to s **re-checkom na mountu I neposredno prije Face ID** (TOCTOU prozor: threshold se mogao promijeniti dok je ekran otvoren) → ne spali se ceremonija ni free-relay slot na osuđenu transakciju;
2. **Settings**: trajni "prag N potpisa" badge (informiranje, ne samo blokada);
3. **relay**: hot-path failure disambiguiran u **eksplicitni 409 s ljudskom porukom** — pokriva i Embed/SDK klijente koji ne prolaze kroz Send.tsx.

I verificirano empirijski: *"confirmed getThreshold reads against a live 2/3 Safe"*. Isti commit nosi i edge-case finesu kod "Aktiviraj račun": bootstrap Safeovi se **ispravno odbijaju** (njihov CREATE2 derivira iz ephemeral-EOA initializera koji cold-path guard ne može reproducirati) — rubni slučaj koji bi naivna implementacija pretvorila u stranded-funds bug.

Opusov ekvivalentni rad (eceb75d — onboarding) također pokriva netrivijalne rubove (orphan passkey → `UnusableWalletError` → usmjerenje na create umjesto mrtve greške; retry na "already pending" race s dual providerom) — Opus *zna* raditi state coverage. Razlika je u tome što kod Fablea i čisto feature commitovi (410311a je feature, ne audit) sistematski nose guard + degradirani put + verifikaciju na živom chainu.

### 4.8 Protuprimjer — gdje je Fable 5 podbacio, a Opus 4.8 ga spasio

**Bez ovoga bi dokument bio marketing, pa čitaj pažljivo.**

Fable (fceab4d, 09:55): wirao **Signal API brisanje passkeya** (`signalUnknownCredential`) u "Arhiviraj" flow — sa svom svojom tipičnom pažnjom (feature-detected, best-effort, balance warning ako je funded, manual fallback). Ali je promašio **sistemsku posljedicu**: passkey je owner za **svih N računa** pod identitetom, na **svim sync uređajima** — brisanje iz Apple Passwords / Google PM za korisnika bez zapisanog seeda = **trajno zaključana sredstva on-chain**. Točno failure mode iz Postmortema 0001 (4,16 EURe zarobljeno) — ovaj put **okidan vlastitim UI-em**.

Opus 4.8 (6c83f51, 14:20) je to **revertao** s breaking-change oznakom, ostavio "do-not-reintroduce" komentar na call siteu i prepisao dokumentaciju (deletion-capable signali označeni FORBIDDEN).

Pouka za usporedbu modela: Fable-ova greška **nije bila u edge-caseovima** (njih je pokrio: balance check, feature detection, fallback) nego u **blast-radius razmišljanju jednu razinu iznad** — "što ovaj API radi cijelom sustavu računa, a ne ovom jednom unosu". Po per-commit pažljivosti fceab4d izgleda uzorno; po posljedici je bio najopasniji commit tjedna. To direktno hrani dimenziju D8 u bodovanju — i razlog je zašto Fable tamo gubi.

(Napomena o atribuciji: revert je vjerojatno potaknuo Matija nakon što je uočio rizik — git ne bilježi tko je inicirao. Bodovanje uzima konzervativnu interpretaciju: greška je Fable-ova bez obzira tko je revert inicirao.)

---

## 5. Kvantifikacija: bodovanje 0–100 po dimenzijama

**Rubrika:** 90–100 = sustavno, po defaultu, bez vanjskog poticaja; 70–89 = pouzdano kad je usmjereno, povremeno propusti; 50–69 = reaktivno, treba poticaj ili drugu iteraciju; <50 = sustavni propusti.
**Ponder:** dimenzije nisu jednako važne za novčanu aplikaciju; ponderi su navedeni i ulaze u zbroj.

| # | Dimenzija | Ponder | Opus 4.8 | Fable 5 | Ključni dokaz |
|---|---|---|---|---|---|
| D1 | Adversarial input model ("svako polje payloada je neprijateljsko") | 15% | 58 | **94** | §3: spoof preživio 2 audita istog filea; Fable ga našao u 1. prolazu (a69913f) |
| D2 | Input validacija na novčanim endpointima | 10% | 60 | **95** | §4.2: 5/8 → 8/8 polja, uint256 range, 400-ne-500 (7d5f4b4) |
| D3 | Ekonomsko/abuse modeliranje (što napad košta *nas*) | 12% | 52 | **93** | §4.3: signer-rotation bypass nitko prije nije formulirao; 2-osni cap + cross-endpoint + bump-on-landed (fd687e1, d15fd4a) |
| D4 | Trust-boundary rezoniranje (server/chain/browser) | 15% | 62 | **94** | §4.5: samoinicijativna korekcija backend→on-chain-first u 34 min (0f08008); §3 event.origin aksiom |
| D5 | State-space pokrivenost (degradirana stanja, TOCTOU, klase klijenata) | 12% | 74 | **91** | §4.7: 3-slojni threshold guard s pre-FaceID re-checkom + 409 za SDK klijente (410311a); Opusu priznat eceb75d |
| D6 | Eliminacija klase buga vs instance (altitude) | 8% | 64 | **92** | §4.4: "parity test" (detekcija) vs `_lib` ekstrakcija (eliminacija) (9d26a9e) |
| D7 | Konvergencija bez churna (fix koji stoji) | 10% | 55 | **85** | §4.6: 3 commita / 2 samoponištavanja vs 1 commit / 0; Fable -15 za fceab4d revert |
| D8 | **Blast-radius / katastrofička svijest** | 12% | **84** | 58 | §4.8: Fable shipao app-inicirano brisanje passkeya (Postmortem-0001 mode); **Opus revertao** + ranije sam maknuo framable addOwner površinu (dd6bfb9) |
| D9 | Dokumentiranje security rationalea (threat model, custody model) | 6% | 68 | **94** | relayer-threat-model.md (166 redaka), security-custody-model.md (235 redaka, 4 mermaid dijagrama, honest caveats) vs follow-up natuknice u commit poruci |
| | **Ponderirani zbroj** | 100% | **67** | **86** | |

### Obrazloženje graničnih ocjena

- **D1 Opus 58, ne niže**: Opus u 7bf46ea *jest* zatvorio bypassabilan `cmd.safeAddress` — adversarial razmišljanje postoji, ali polje-po-polje (reaktivno), ne kao default aksiom nad cijelim payloadom.
- **D7 Fable 85, ne više**: 17 od 18 Fable commitova stoji netaknuto, ali fceab4d je revertan — i to nije kozmetika nego sigurnosni revert. Churn *rate* mu je bolji od Opusovog (1/18 vs 2-poništavanja-u-3-commita na istom flowu), ali težina poništenog commita je veća.
- **D8 Opus 84, Fable 58 — jedina dimenzija gdje Opus uvjerljivo pobjeđuje**: Opus je u tjednu imao **dva** poteza čistog blast-radius razmišljanja (uklanjanje framable addOwner površine prije nego što je itko prijavio problem; revert brisanja passkeya), Fable jedan ozbiljan promašaj točno te vrste. Da je fceab4d ostao u produkciji i jedan korisnik bez seeda kliknuo "Arhiviraj", šteta bi bila trajna i nepopravljiva — ništa što je Fable taj dan našao nema tu težinu u suprotnom smjeru.

### Sirove brojke (bez interpretacije)

| Metrika | Opus 4.8 | Fable 5 |
|---|---|---|
| Audit prolaza kroz Embed.tsx prije nalaska origin-spoofa | 2 (od toga 1 multi-agent) | 1 (našao) |
| Validirana polja na /api/relay (od 8) | 5 | 8 |
| Nezavisne osi rate-limita na relayu | 1 (per-signer) | 3 (signer, IP, global) + Turnstile sloj |
| Endpointi pokriveni zajedničkim gas budžetom | 1 | 2 (bypass zatvoren) |
| Samoponištavajući commitovi na istom flowu | 2 (df79786, cdda3bc) | 0 |
| Vlastiti commitovi revertani zbog sigurnosti | 0 | **1 (fceab4d — kritičan)** |
| Samoinicijativne sigurnosne korekcije vlastitog koda | 0 | 1 (0f08008, 34 min) |
| Security dokumentacija (novi redci) | ~0 (natuknice u commit msg) | ~400 (threat model + custody model) |
| Empirijske on-chain verifikacije tvrdnji u commitu | povremeno | sustavno (live 2/3 Safe, cold-path guard, getThreshold) |

---

## 6. Sinteza — kako ovo reći kolegi u tri rečenice

1. **Razlika nije "Fable nađe više bugova"** — Opusov multi-agent audit je našao ozbiljne stvari (framable addOwner, float-balance, Max-rounding). Razlika je u **defaultnom mentalnom modelu**: Fable kreće od aksioma "payload je neprijateljski, server je nepouzdan, sustav će se zateći u degradiranom stanju" i zato nalazi klasu problema (origin spoof, signer rotation, compromised-server injection) koju Opus nalazi tek kad ga konkretna manifestacija podsjeti — što se mjeri time da je spoof preživio dva Opusova audita *istog filea*, a Fable-u pao u prvom prolazu.
2. **Fable konvergira brže i na višoj razini apstrakcije**: 1 commit bez poništavanja tamo gdje je Opus trebao 3 s dva samoponištavanja; eliminacija klase buga (_lib) tamo gdje je Opus predlagao detekciju instance (parity test); i jedini je u historyju repoa sam sebi flagirao security regresiju bez vanjskog poticaja.
3. **Ali nije strogo nadskup**: Fable je shipao najopasniji commit tjedna (app-inicirano brisanje passkeya = trajno zaključana sredstva), a Opus ga je revertao — u blast-radius dimenziji Opus je bio bolji. Ponderirano za novčanu aplikaciju: **86 vs 67**, s jasnom asimetrijom tipova grešaka: Opusove greške su *propusti pokrivenosti* (ranjivost ostane), Fable-ova greška je bila *prekoračenje* (feature koji nije smio postojati). Za wallet su prve češće, a druge skuplje po incidentu — zato oba broja drži uz §4.8, ne bez njega.

---

*Generirano 2026-06-10. Svi hashevi provjerljivi u repou: `git show <hash>`. Analizu izradio Claude Fable 5 (samoevaluacija — vidi caveate u §1).*
