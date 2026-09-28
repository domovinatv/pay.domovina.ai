# Webhookovi i eventi — pregled 2026-09-28

Povod: prelazak na model u kojem merchant ima vlastiti Monerium KYC/KYB račun, a mi samo
u realnom vremenu javljamo stanje uplate (analogno Stripe webhookovima). U tom modelu
obavijesti postaju proizvod, pa je pregled usmjeren na njih.

Nastavlja se na `docs/reviews/2026-07-fable5/` — tamo već popisani nalazi (BW-xx) ovdje su
samo potvrđeni kao još otvoreni.

## Stanje u produkciji (D1, 2026-09-28)

- 99 dolaznih Monerium eventova, svima potpis OK. 49 issue ordera, svaki točno 1× `order.created` + 1× `order.updated`. 0 `rejected`.
- 84 intenta: 42 `paid` (svi imaju order), 42 `expired`.
- 47 forwardova: 45 `confirmed`, 1 `self_target_noop`, 1 `failed` (2026-05-21, 1,02 EUR, `e6zmauemwu`).
- 2 ordera bez forwarda (2026-05-21, 2× 1,01 EUR, testiranje prije race-fixa).
- 1 kasna uplata: intent `2abjke6unj5u` istekao (TTL tada 15 min), novac je proslijeđen, intent je ostao `expired`, merchant nije dobio nikakav event.

## Što je dobro

- Dolazni potpis: Standard Webhooks, rotacija ključa, usporedba u konstantnom vremenu.
- Append-only log svih dolaznih eventova (`monerium_webhook_events`).
- `paid` se okida tek na on-chain potvrdu forwarda, s 3 puta potvrde i atomskim single-fire flipom.
- Stabilni `webhook-id` na izlaznim eventovima; `forward.blocked` + Telegram alarm za blokirane forwarde.
- Faza plaćanja se računa pri čitanju (`intents/stage.ts`), jedan izvor istine za checkout, Flutter i merchanta.

## Nalazi

### A. Izlazni (merchant) webhookovi — najvažnije za novi model

**A1. Jedan pokušaj, nema retryja ni loga isporuke.** `intents/outbound.ts` napravi jedan `fetch`;
kod 5xx ili timeouta event je zauvijek izgubljen (ostaje samo `console.error`). Nema tablice isporuka,
nema ponovnog slanja iz admina. Stripe ponavlja do 3 dana.
Popravak: outbox tablica (`event_id, type, payload, attempts, next_attempt_at, last_status, delivered_at`),
slanje iz outboxa, cron retry s eksponencijalnim backoffom, admin "pošalji ponovno".

**A2. Postoji samo završni event.** Nedostaju:
- `payment.received` na `order.created` (uplata zaprimljena kod Moneriuma, ~1 s) — kartični "authorized";
- `payment.rejected` na `order.updated state=rejected` — danas se ne događa ništa, intent tiho istekne;
- `payment.late` / paid nakon isteka — `markIntentPaid` mijenja samo `pending`, pa kasna uplata ne javi ništa (dogodilo se: `2abjke6unj5u`).

**A3. `webhook-id` nije jedinstven po tipu eventa.** `int_<sid>` je isti za svaki event istog intenta.
Čim dodamo `payment.received`, primatelj koji deduplicira po id-u odbacit će kasniji `paid` kao duplikat.
Id mora uključiti tip, npr. `evt_<sid>_received`, `evt_<sid>_paid`.

**A4. Jedan globalni `INTENT_WEBHOOK_URL` + tajna.** Svi tenanti idu na isti endpoint (danas pinka).
Novi model traži URL i tajnu po tenantu (kolone u `tenants` ili zasebna tablica endpointa).

**A5. Payload nema vrijeme eventa ni razlog čekanja.** Dodati `occurred_at` i, za `payment.received`,
`review: meta.evaluation` (npr. `counterpart is not screened`) da merchant zna da prva uplata čeka provjeru.

### B. Dolazni Monerium webhookovi

**B1. Dedup prije obrade (BW-03, otvoreno).** `index.ts:194` upiše `webhook-id` kao obrađen prije
`upsertMoneriumOrder` i forwarda. Ako obrada pukne, Monerium retry se odbaci kao duplikat.

**B2. Stanje ordera može ići unatrag.** `upsertMoneriumOrder` (`monerium/db.ts:38`) bezuvjetno prepisuje
stanje. Zakašnjeli retry `order.created` nakon `order.updated` vratio bi `processed → pending` i obrisao
`processed_at` i `tx_hashes`. U podacima se nije dogodilo, ali Monerium ponavlja do 12 h.
Popravak: prepisati samo ako novo stanje nije niže (`placed < pending < processed|rejected`).

**B3. Nema pričuvnog puta za propušteni Monerium webhook.** `/sync` je samo ručni admin endpoint.
Popravak: cron koji povlači nedavne ordere s Monerium API-ja i obrađuje ih kroz isti put kao webhook.

**B4. Nema tolerancije na `webhook-timestamp` (BW-14, otvoreno, nizak rizik).**

### C. Forward (samo postojeći MPT rail)

**C1. Neuspjeli forward se nikad ne ponavlja (BW-04, otvoreno)** i za njega nema Telegram alarma
(alarm postoji samo za `blocked`). Povijesno: 1 `failed` + 2 ordera bez forwarda, svi iz testiranja 2026-05-21.

**C2. Pogrešan iznos se označi kao `paid` (BW-01, otvoreno).** `markIntentPaid` ne uspoređuje iznos.

**C3. Check-then-act kod forwarda (BW-02, otvoreno).**

### D. Checkout

**D1.** Veliki uspjeh ("Plaćeno!") prikazuje se tek na `settled`; faza `received_processing` postoji
ali se prikazuje kao čekanje. Polling svake 2 s je dovoljan.

## Preporučeni redoslijed

1. A1 outbox + retry — temelj svega ostalog.
2. A2 + A3 + A5: skup eventova `payment.received / payment.paid / payment.rejected / payment.late`, id po tipu.
3. D1: checkout prikazuje uspjeh na `received`.
4. B2 + B1: monotono stanje i dedup nakon obrade.
5. B3: cron usklađivanje s Monerium API-jem.
6. A4: endpoint po tenantu (kad stigne drugi merchant).
Samo za MPT rail: C1 (retry + alarm), C2.
