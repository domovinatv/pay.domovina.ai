# HANDOFF — Payment status timeline („gdje su moji novci")

_Ovaj prompt pokreni u zasebnoj Claude Code sesiji. Nakon implementacije
radimo review u glavnoj sesiji._

---

## 0. Prvo: git worktree (OBAVEZNO — projektno pravilo)

Ova sesija radi paralelno s drugom. Prije bilo kakvih izmjena:

```bash
git worktree add ../pay.domovina-status-timeline feat/payment-status-timeline
cd ../pay.domovina-status-timeline
```

Svi editi idu u taj worktree. Bez ovoga dvije sesije dijele isti index i
commit pokupi tuđe fileove (vidi `CLAUDE.md`).

## 1. Kontekst — pročitaj prije koda

Puni objektivni brief (observability mapa, Monerium model, inventar
postojeće implementacije, UX dizajn) je u:

**`docs/plans/payment-status-timeline.md`** — pročitaj cijeli prije rada.

Kratki sažetak *zašto*: happy path je ~4 s, ali **prva** transakcija novog
payera zna visjeti 15–30 min bez ikakvog feedbacka pa korisnik misli da je
novac nestao. Gradimo pošten, po-korak status koji imenuje *gdje* je novac.

## 2. Tvrda ograničenja iskrenosti (NE KRŠITI)

Ova pravila dolaze iz stvarnog Monerium modela — copy koji ih prekrši laže:

1. **Slijepi prozor (korisnik → Revolut → SEPA tranzit) nema signal.**
   Monerium `issue` order NE postoji dok novac ne sjedne. Ne animirati lažni
   napredak; u tom prozoru pokazati samo **proteklo vrijeme + očekivanje**.
2. **Ne postoji „compliance/AML hold" state.** Review je utopljen u generički
   Monerium `pending`. Ne tvrditi precizno „zadržano radi AML" — to je naša
   inferencija iz vremena, ne signal.
3. **Ne obećavati „sekunde" za prvu uplatu.** Nema signala prva-vs-iduća.
4. **Imenuj skrbnika na svakom koraku** (tvoja banka → Monerium → blockchain
   → primatelj) i **označi dokaz vs pretpostavku** (✅ potvrđeno / ⏳ u tijeku
   / ◌ čeka se).
5. **Diskriminator dva stalla = postoji li `monerium_orders` redak za `sid`:**
   - nema ordera → zapelo prije Moneriuma → „Čekamo tvoju banku. Provjeri u
     Revolutu."
   - order `placed/pending` → Monerium obrađuje → „Stiglo je, novac je
     siguran, radi se provjera. Ne moraš ništa."

## 3. Odluke (već dogovorene — ne preispituj)

- **Površine:** sve tri — (a) `/checkout/:sid`, (b) Flutter in-app status,
  (c) merchant/POS pogled.
- **Transport:** ostati na postojećem **2 s pollingu**. NE graditi SSE/DO.
- **Notifikacija (SMS/push):** IZVAN opsega — faza 2.
- **`getForwardStatus`:** spojiti za završni „potvrđeno on-chain" korak.

## 4. Kanonski stage model (jedan izvor istine)

Backend računa fazu **na čitanju** joinom triju tablica
(`payment_intents ↔ monerium_orders ↔ monerium_forwards`, već povezane preko
`sid` / `order_id` / `forward_id`). **Bez migracije sheme.** Enum:

| `stage` | Uvjet iz podataka | Skrbnik | Marker |
|---------|-------------------|---------|--------|
| `awaiting_payment` | intent `pending`, NEMA `monerium_orders` retka | banka | ◌ |
| `received_processing` | `monerium_orders.state ∈ {placed,pending}` | Monerium | ⏳ |
| `minted` | `order.state='processed'` + `meta.txHashes` | blockchain | ✅ |
| `forwarding` | `monerium_forwards.status='submitted'` + `tx_hash` | relay | ⏳ |
| `settled` | forward `confirmed` (preko `getForwardStatus`) **ILI** `order.processed` ako se forward ne očekuje (direktni mint) | primatelj | ✅ |
| `rejected` | `order.state='rejected'` + `meta.rejectedReason` (terminal) | povrat | ⚠️ |
| `expired` | intent `expired`, order nikad stigao (terminal) | — | ⚠️ |

Napomene:
- **`bank_sending` NIJE zaseban backend state** — isti podatak kao
  `awaiting_payment`; klijent ga izvodi iz proteklog vremena (progresivno
  otkrivanje). Backend vraća `elapsedSeconds` i pušta klijentu copy.
- **Put bez forwarda (direktni mint, bare `0x` cilj):** nema `forwarding`;
  `settled` na `order.processed`. Backend mora znati očekuje li se forward
  (iz routinga u memo — `mpt:`/`cmp:` → da; bare `0x` → ne).
- **Ne dirati** postojeći `markIntentPaid` / merchant webhook semantiku.
  Novi stage-izračun je **aditivan** (finije faze iznad postojećih tablica),
  ne mijenja kad intent postaje `paid`.

## 5. Posao — po dijelovima

### 5.1 Backend — stage endpoint
- Dodati izračun faze (novi modul, npr. `backend/src/intents/stage.ts`) koji
  joina tri tablice po `sid` i vraća kanonsku fazu + `steps[]` (svaki:
  `key`, `status` proven|in_progress|waiting|failed, `at` timestamp,
  `txHash`/`txHashes`, `custodian`), plus `elapsedSeconds` od kreiranja
  intenta i od zadnjeg prijelaza, plus `rejectedReason` na rejected.
- Izložiti kroz **postojeći** `GET /api/intents/:sid` (proširiti response,
  zadržati backward-compat polja `state`) ili dodati `…/status`. Preferiraj
  proširenje postojećeg da checkout polling ne treba drugi zahtjev.
- **Spojiti `getForwardStatus`** (`router/safe.ts:217`, sad se nikad ne
  poziva): kad je forward `submitted`, na polling-read provjeri receipt i
  ako je mined, `updateForward(status='confirmed')`. Time `settled` postaje
  stvaran on-chain potvrđen korak. Paziti da poll ne blokira (idempotentno,
  best-effort u read putu ili u `waitUntil`).

### 5.2 Frontend A — checkout timeline (`backend/src/checkout/page.ts`)
- Zamijeniti binarni pending/paid prikaz **vertikalnom timeline** s markerima
  po §4 i progresivnim otkrivanjem po vremenu:
  - 0–8 s: suptilan spinner „Čeka se uplata…"
  - 8–25 s: „Tvoja banka obrađuje uplatu…" + skrbnik
  - 25 s+: proširi „Prva uplata s novog računa zna potrajati (do 30 min).
    Novac je siguran. Ne moraš ništa raditi." + link „Provjeri u Revolutu"
  - na dolasku ordera: skok na „✓ Stiglo — kuje se"
- Zadržati 2 s polling loop (`page.ts:362`), samo renderirati bogatiji odgovor.
- Terminalni ekrani: `rejected` (prikaži `rejectedReason` pošteno, „novac se
  vraća na tvoj račun"), `expired` (postojeće).

### 5.3 Frontend B — Flutter in-app status (`lib/ui/home_page.dart`)
- App je sad čisti QR generator koji **ne zove** `/api/intents`. Da bi pratio
  status, mora: nakon generiranja QR-a **kreirati intent** (`POST /api/intents`
  s `sid`), pa **pollati** status endpoint i renderirati istu timeline
  komponentu (Dart).
- Izdvoji stage→copy tablicu u jedan Dart file da se poklapa s checkout copyjem.

### 5.4 Frontend C — Merchant/POS pogled
- Fullscreen/kiosk varijanta timeline-a za trgovca: veliki dominantni redak
  stanja + iznos, minimalna kroma, ostaje živ kroz duge čekanje, glanceable
  preko pulta. Može biti mode-toggle na istom Flutter ekranu (npr. „POS mod")
  ili zaseban route. Naglasak: veliki „Primljeno ✓" na `settled`.

## 6. Verifikacija (obavezno prije predaje)
- `cd backend && npm test` (ili postojeći test runner) — stage izračun
  pokriti unit testovima za sve prijelaze uključujući: nema ordera →
  `awaiting_payment`; `placed` → `received_processing`; `processed` bez
  forwarda → `settled`; `submitted` → `forwarding`; `confirmed` → `settled`;
  `rejected`; `expired`.
- Ručno prošetati checkout stranicu kroz faze (može mock/seed D1 redaka).
- Flutter: `flutter analyze` + build web.
- Ne mijenjati Monerium webhook gating (`index.ts:222`) niti
  `markIntentPaid` timing.

## 7. Izvan opsega (ne raditi ovdje)
- SSE/DO `IntentHub` push.
- SMS/push notifikacija dugih čekanja.
- `referenceNumber` (vs `memo`) korelacija — zaseban rizik (Monerium breaking
  change 15.12.), zabilježen u knowledge docu, ali ne u ovom handoffu.
- POS credit-risk / „provizorno prihvaćeno" — poslovna odluka, ne UI.

## 8. Predaja
Commit + push na `feat/payment-status-timeline` (auto-push je odobren na ovom
projektu). Kratko sažmi: koje fileove si dirao, koji testovi prolaze, i svako
mjesto gdje si morao odstupiti od ovog plana. Vraćamo se u glavnu sesiju na
review.
