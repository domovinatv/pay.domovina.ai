# Payment status timeline — „gdje su moji novci"

_Captured 2026-07-07. Objective observability knowledge + UX design for a
step-by-step status experience on the MPT rail. Grounds every claim in the
current implementation and the authoritative Monerium order lifecycle, so we
never render progress we cannot actually observe._

## Why this exists

The MPT happy path (QR → SEPA Instant → EURe mint → forward) settles in
**~4 s**. But a **first** transaction from a brand-new payer can hang for
**15–30 min** with **zero** feedback, so the payer/merchant fears the money
vanished. The current buyer surface (`/checkout/:sid`) only renders
`pending → paid | expired` and jumps straight from "waiting" to "done" — it
never says *where* the money is. This doc defines an honest, per-stage
timeline built **only** from signals we can actually observe.

---

## Part 1 — Objective observability map

### 1.1 The physical rail, and where we have signal

| # | Dionica | Skrbnik novca | Vidimo li? | Signal / izvor | Latencija |
|---|---------|---------------|-----------|----------------|-----------|
| 0 | Intent kreiran, QR prikazan | — | ✅ | `payment_intents.state='pending'` (`intents/db.ts:11`) | 0 |
| 1 | Korisnik potvrđuje uplatu u banci (Revolut) | Korisnik/Revolut | ❌ **slijepo** | — (order NE postoji) | var. |
| 2 | Banka šalje SEPA | Revolut | ❌ **slijepo** | — | **prva tx: 15–30 min+**; Instant: sek. |
| 3 | SEPA u tranzitu do Monerium (LHV IBAN) | u tranzitu | ❌ **slijepo** | — | Instant: sek.; regular: do 1 rad. dan |
| 4 | **Stiglo u Monerium** | Monerium | ✅ **PRVI SIGNAL** | webhook `order.created`, `monerium_orders.state='placed'\|'pending'` | **4–5 s** nakon dolaska SEPA |
| 5 | EURe iskovan na Gnosis | on-chain | ✅ | webhook `order.updated` + `state='processed'` + `meta.txHashes` | **+5–15 s** |
| 6 | Prosljeđivanje (Safe + Zodiac Roles) | naš relay | ✅ | `monerium_forwards.status='submitted'` + `tx_hash` (broadcast) | sek. |
| 7 | Forward potvrđen on-chain | on-chain | ⚠️ napisano, **nije spojeno** | `getForwardStatus` (`router/safe.ts:217`) postoji ali se **nikad ne poziva** | ~5 s |

**Dvije istine koje diktiraju cijeli dizajn:**

1. **Dionice 1–3 su potpuno slijepe.** Monerium `issue` order **ne postoji**
   dok novac ne sjedne na IBAN — Monerium ga kreira automatski *tek na
   dolasku SEPA* (`docs/monerium-private.md:224-226`). Nema se što pollati
   prije toga. Jedini signal u tom prozoru je **proteklo vrijeme**. → Ovdje
   **ne smijemo animirati lažni napredak.**
2. **Monerium je gotovo nikad uzrok 30-min čekanja.** Produkcijski mjereno
   (`docs/monerium-private.md:431`): `order.created` **4–5 s** nakon SEPA
   Instant dolaska, mint `processed` **+5–15 s**. Cijela Monerium dionica je
   ~10–20 s. **Onih 15–30 min je skoro uvijek Revolut/SEPA-tranzit strana.**

### 1.2 Diskriminator dva stalla — najvrjednije što već imamo

Prisutnost `monerium_orders` retka za dani `sid` razdvaja dva psihološki
potpuno različita zastoja:

- **Nema ordera nakon N sekundi** → zapelo je **prije Moneriuma**
  (Revolut fraud-hold / regular SEPA umjesto Instant / tranzit). Ne možemo
  čak ni dokazati da je korisnik platio.
  → Poruka: „Čekamo tvoju banku. Provjeri u Revolutu je li uplata poslana."
- **Order postoji (`placed`/`pending`) ali ne `processed` nakon N sekundi**
  → **Monerium obrađuje/provjerava**. Novac je **dokazivo** kod reguliranog
  EMI-ja.
  → Poruka: „Stiglo je — novac je siguran. Radi se provjera. Ne moraš ništa."

Taj redak već spremamo (`upsertMoneriumOrder`, `monerium/db.ts:25`) na svaki
webhook — ali ga **buyeru nikad ne izložimo**. To je jezgra feature-a.

### 1.3 Monerium order model — što stvarno postoji (i što NE)

Enum stanja (`docs.monerium.com/api`, `api.md:2195`; potvrđeno u
`docs/monerium-private.md`):

| `state` | Značenje |
|---------|----------|
| `placed` | Order kreiran, još neobrađen. |
| `pending` | Čeka izvršenje — **review, ILI mint, ILI SEPA namira** (isti opaki state). |
| `processed` | Uspješno dovršeno. `meta.txHashes` sadrži mint tx. |
| `rejected` | Odbijeno — **compliance ILI insufficient funds** (isti state, razlikuje se samo `meta.rejectedReason` prozom). |

Webhook eventi (samo dva za order): `order.created` (stiže rano, obično
`placed`, **prije** minta) i `order.updated` (na `processed`/`rejected`,
nosi `meta.txHashes` ili `meta.rejectedReason`). Oba nose **cijeli** Order
entitet u `data`. `state` je **top-level**, ne u `meta`.

**Tvrda ograničenja iskrenosti (moraju se poštovati u copyju):**

- ⛔ **Ne postoji zaseban „compliance / AML hold" state ni flag.** Review je
  utopljen u generički `pending`. Ne možemo iz `state` znati je li order u
  AML reviewu ili samo mid-mint. Bilo kakav „pod provjerom" tekst je **naša
  inferencija iz proteklog vremena**, ne Monerium signal.
- ⛔ **Nema signala prva-vs-iduća transakcija.** Ni službeni ni naši docs ne
  dokumentiraju da je prvi inbound sporiji. **Ne obećavati „sekunde" za prvu
  uplatu.**
- ⛔ **`rejected` ne razlikuje compliance od insufficient-funds** osim
  parsiranjem `meta.rejectedReason` (slobodan tekst).
- ⚠️ **Korelacija: `referenceNumber`, ne `memo`.** Od 15.12. strukturirana
  referenca stiže isključivo u `referenceNumber` (`api.md:4061`). Naš
  `parseSidFromText` (`monerium/sid.ts:116`) trenutno vadi `sid` iz memo —
  status-korelacija mora čitati i `referenceNumber`. (Zaseban rizik, izvan
  čistog UI posla, ali zabilježiti.)
- ⚠️ **SEPA recall MOŽE stići nakon što je EURe već proslijeđen**
  (`docs/compliance/INTERNO-monerium-tos-analiza.md` §18) — gubitak-rizik,
  nije status signal. Ne prikazivati kao stanje.

Pouzdanost dostave: webhook retry 10×/12 h, dedup po `webhook-id`
(već implementirano, `index.ts:195`). Postoji i pull `/orders`
rekonsilijacija kao backstop na izgubljeni webhook.

### 1.4 Trenutna implementacija — inventar

- **Webhook:** `POST /api/monerium/webhook` (`backend/src/index.ts:151`).
  Hvata `order.created`/`order.updated`, upsert u `monerium_orders`.
  Auto-forward **samo** na `kind='issue' && order.updated && state='processed'`
  (`index.ts:222`) — namjerno NE na `order.created` (revert prije minta).
- **D1 tablice:** `monerium_orders` (state/kind/amount/tx_hashes/…),
  `monerium_forwards` (`pending→submitted→confirmed→failed`, ali `confirmed`
  se nikad ne dosegne — `forwardViaSafe` ne čeka mining, `safe.ts:128`),
  `payment_intents` (`pending|paid|expired`, keyed by `sid`).
- **Korelacija:** `sid` (10–12 char) u SEPA memo → `parseSidFromText`
  (`monerium/sid.ts:116`). Ne po iznosu/IBAN-u.
- **Buyer UI:** server-rendered `GET /checkout/:sid`
  (`backend/src/checkout/page.ts:29`), polla `/api/intents/:sid` svake 2 s
  (`page.ts:362`), renderira **samo** `pending`/`paid`/`expired`. Skače
  pending→paid, bez međukoraka.
- **Intent flip na `paid`:** događa se na **broadcast** forwarda (`submitted`),
  **ne** na mining (`index.ts:532`).
- **SSE:** ne postoji — `GET /api/intents/:sid/stream` vraća 404 namjerno
  (`intents/api.ts:126`). DO `IntentHub` dizajn u
  `docs/product-vision/payment-intents-and-sse.md`, neizgrađen.
- **Flutter app** (`lib/ui/home_page.dart`): čisti QR *generator*, ne zove
  `/api/intents`, ne prati status.

---

## Part 2 — UX design (honest stage machine)

### 2.1 Načela

1. **Nikad lažni napredak.** U slijepom prozoru (1–3) pokazujemo proteklo
   vrijeme + očekivanje, ne animiranu traku prema 90%.
2. **Imenuj skrbnika.** Na svakom koraku reci *čiji* je novac trenutno:
   tvoja banka → Monerium → blockchain → primatelj. To izravno odgovara na
   „gdje su moji novci".
3. **Označи dokaz vs pretpostavku.** Svaki korak nosi marker:
   ✅ potvrđeno (imamo dokaz), ⏳ u tijeku (imamo signal), ◌ čeka se
   (slijepo, procjena po vremenu). Prijelaz ◌→✅ na dolasku u Monerium je
   emocionalna isplata.
4. **Progresivno otkrivanje po vremenu.** Sretan put ostaje čist (Apple-Pay
   feel, korisnik nikad ne vidi strašni tekst jer se riješi za 4 s). Slijepi
   zastoj otkriva objašnjenje **točno kad korisnik počne brinuti** (~15–20 s),
   prije panike.
5. **Ponudi izlaz.** Kad zapne u slijepom prozoru, pozovi „Provjeri u
   Revolutu" — jer ne možemo razlikovati „banka drži" od „korisnik nije
   poslao".

### 2.2 Korisničke faze

| Faza (UI) | Uvjet iz podataka | Skrbnik | Marker |
|-----------|-------------------|---------|--------|
| **Čeka uplatu** | intent `pending`, nema `monerium_orders` retka | tvoja banka | ◌ |
| **Banka šalje** (isti podatak, otkriveno nakon ~20 s) | ↑ + proteklo vrijeme > prag | tvoja banka | ◌ |
| **Stiglo — provjera / kovanje** | `monerium_orders.state ∈ {placed,pending}` | Monerium | ⏳ |
| **Iskovano** | `order.state='processed'` + `txHashes` | blockchain | ✅ |
| **Prosljeđivanje** | `monerium_forwards.status='submitted'` + `tx_hash` | naš relay | ⏳ |
| **Gotovo** | forward `confirmed` (spojiti `getForwardStatus`) *ili* `submitted` ako nema forwarda | primatelj | ✅ |
| **Odbijeno** (terminal) | `order.state='rejected'` + `rejectedReason` | povrat na račun | ⚠️ |
| **Isteklo** (terminal) | intent `expired`, order nikad stigao | — | ⚠️ |

Napomena: za **direktni mint** (bare `0x` cilj, bez routinga) nema koraka
Prosljeđivanje — „Gotovo" je na `order.state='processed'`. Stage-machine
mora podnijeti i put bez forwarda.

### 2.3 Vremenska traka progresivnog otkrivanja (slijepi prozor)

- **0–8 s:** suptilan spinner, „Čeka se uplata…" (čisto, POS-like).
- **8–25 s:** „Tvoja banka obrađuje uplatu…" + imenovan skrbnik.
- **25 s+:** proširi karticu: „Prva uplata s novog računa zna potrajati
  (do 30 min). Novac je siguran. Ne moraš ništa raditi." + link
  „Provjeri u Revolutu".
- **Na dolasku ordera (bilo kad):** skok na „✓ Stiglo — kuje se" — velika
  olakšica, marker ◌→⏳/✅.

---

## Part 3 — Implementation plan (za handoff)

Vrijednost je ~80 % „join tri tablice + izloži kao faze + renderiraj";
telemetrija uglavnom već postoji u D1.

1. **Backend — obogatiti status endpoint.** `GET /api/intents/:sid` (ili
   novi `/api/intents/:sid/status`) vraća **stage timeline** joinom
   `payment_intents ↔ monerium_orders ↔ monerium_forwards`
   (već povezani preko `sid` / `order_id` / `forward_id`). Faza se
   **računa na čitanju** — bez migracije sheme. Vraćati: trenutnu fazu,
   marker (proven/in-progress/waiting), skrbnika, timestampe po fazi,
   `tx_hash`/`txHashes` gdje postoje, `rejectedReason` na rejected.
2. **Frontend — checkout timeline.** `backend/src/checkout/page.ts` renderira
   vertikalnu timeline s markerima + progresivnim otkrivanjem po vremenu
   (2.3). Zadržati postojeći 2 s polling — SSE je zasebna optimizacija.
3. **(Opcionalno) spojiti `getForwardStatus`** (`router/safe.ts:217`) za
   završni „Gotovo (potvrđeno on-chain)" mikro-korak.
4. **Ostaje izvan ovog posla, ali zabilježeno:** `referenceNumber`
   korelacija (§1.3), SSE/DO push (faza 2), notifikacija za duge čekanje
   (SMS preko otp.domovina.ai / push) da POS-trgovac ne mora buljiti u
   ekran.

### Otvorena pitanja za dogovor prije handoffa

- **Površine:** samo `/checkout/:sid`, ili i in-app Flutter status, ili i
  zaseban merchant/POS pogled?
- **Transport:** ostati na 2 s pollingu (jednostavno, radi danas) ili odmah
  graditi SSE/DO?
- **Duga čekanja:** notifikacija (SMS/push) u opsegu ili faza 2?
- **POS credit-risk:** za 30-min prvu tx na POS-u — čeka li trgovac, ili
  „provizorno prihvaćeno" pa async potvrda? (Poslovna odluka, ne UI.)
