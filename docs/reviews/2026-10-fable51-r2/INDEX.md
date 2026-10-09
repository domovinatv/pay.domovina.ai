# Fable 5.1 review r2 — što je Opus 5.5 napravio od 2. 10. (2026-10-09)

Treći nezavisni prolaz, na HEAD `ef6622c`, fokus na **40 commita od `be47b62`**
(prethodni review `../2026-10-fable51/`): ADR 0017 multi-tenant rail, ADR 0018
stray resolver (+ rano „zaprimljeno"), ADR 0019 faza 0 (detektor krađe),
`resolved_offrail`, admin prijava Access+passkey, Shopify app (put B). Metoda:
cijeli novi/izmijenjeni backend i Shopify kod **pročitan ručno** (Fable 5.1),
svaki nalaz s file:line; ADR-ovi korišteni samo za namjeru, ne kao dokaz.

Deliverable za Opus 5.5 je **`implementation-plan.md`**. Ovaj INDEX je karta.

## Ground checks (2026-10-09, zeleno)

| Provjera | Rezultat |
|---|---|
| `backend`: `vitest run` | **321/321 pass** (21 fajlova; bilo 124 → 248 → 321) |
| `backend`: `tsc --noEmit` | čist |
| `shopify/worker`: `vitest run` | **18/18 pass** |
| `shopify/worker`: `tsc --noEmit` | čist |
| `wallet/`: `git diff --stat be47b62..HEAD -- wallet` | **prazan** → svi wallet nalazi iz srpnja i listopada stoje |

Nema tip-grešaka; svi nalazi su semantički. Testovi koje je Opus napisao su
dobri za ono što testiraju (atribucija po tenantu, replay produkcijskih strayeva,
latch, offrail finalnost); rupe su u **modelu prijetnje**, ne u pokrivenosti
koda.

## Dokumenti

| Fajl | Sadržaj |
|---|---|
| `rail-multi-tenant-stray.md` | SR-01..06 (resolver), MT-01..10 (multi-tenant), §C stanje prethodnih nalaza |
| `detector-admin-offrail.md` | TD-01..05 (detektor krađe), OF-01..02 (offrail), AD-01..05 (admin), §D što je dobro |
| `shopify-app.md` | SH-01..10 + što je dobro |
| `implementation-plan.md` | P0–P2 za Opus, NE DIRAJ, redoslijed, testovi |

## Brojevi

| Severity | Novo (r2) | Preneseno otvoreno iz 10/02 |
|---|---|---|
| MONEY / SEC (gubitak novca ili PII bez tajne) | **6** — SR-01, SR-02, MT-01, MT-04, TD-01, SH-01 | BW-01, BW-18/WC-01/02, WU-01, BW-13 |
| MONEY-RISK / RISK | **12** — SR-03, SR-04, SR-05, MT-02, MT-03, MT-06, MT-09, MT-10, TD-02, TD-04, SH-02, SH-03 | BW-15, BW-16, BW-17, BW-22, XD-01, XD-02 |
| BUG / OPS | **5** — AD-01, MT-05, MT-07, SH-04, OF-01 | BW-11/20/21/23/24, FL-N-01..03 |
| LOW | **9** — SR-06, MT-08, TD-03, TD-05, OF-02, AD-03/04/05, SH-05..10 | — |

## Pet stvari koje treba znati

1. **SR-01 — resolver je napadiv bez tajne.** Tenant `italk` prima intente bez
   ključa, whitelista mu uključuje svaki self-registrirani wallet Safe (bez
   dokaza posjeda), a resolver pušta otvorene intente ispred isteklih. Svatko s
   wallet Safe-om može držati otvorene intente za uobičajene iznose i pokupiti
   zalutalu uplatu čiji je intent istekao; ili samo griefati conflictom. ADR
   0018 tvrdnja „napadač bez API pristupa ne može stvoriti kandidata" ne vrijedi.
   Popravak je malen (kandidat mora biti „trusted": statična whitelista ili
   intent kreiran s ključem) — **P0-1**.
2. **TD-01 — detektor krađe se zaobilazi relay ugovorom.** Klasifikacija po
   `tx.to` daje ℹ️ „ručni 2/3 transfer" za krađu kroz bilo koji multicall.
   Klasificirati po Safe eventu `ExecutionFromModuleSuccess` — **P0-4**.
3. **MT-01 — `contribution.sepa` ide na pinku za sve tenante.** Jedini event bez
   `tenantId`; curi IBAN+ime darovatelja prve župe trećoj strani. Latentno dok
   je `MULTI_TENANT_RAIL=0` — **P0-3**.
4. **SR-02 + BW-01 — ručni reroute bez provjere iznosa i stanja.** 1 € može
   flipati intent od 500 € u `paid` (operaterska greška, dva klika), ili poslati
   drugi transfer na već plaćeni intent bez ikakve obavijesti. BW-01 iz srpnja
   je i dalje otvoren i sad ima novi ulaz — **P0-2**.
5. **Prethodni P0 nije napravljen, osim P0-2 (latch) i pola P0-5.** Dokaz
   posjeda na walletima (P0-3), `/embed` clickjacking (P0-4), deterministički
   istek (P0-7), admin retry (P0-6), dropped-tx (P1-1) stoje. Wallet nije diran.
   ITalk rola i dalje nema on-chain uvjete (ADR 0019 je `Proposed`); detektor
   faze 0 je jedina obrana od ukradenog ključa, zato TD-01/02 nisu LOW.

## Što je Opus napravio dobro (i što treba zaštititi testovima koji već postoje)

Atribucija webhooka samo tajnom tenanta iz URL-a; AAD na tajnama; latch 0016/0018
kao odluka; `park` prijavljuje memo, ne pogodak; `authorizeForward` ostaje jedina
točka odluke i za resolver i za reroute; offrail provjera on-chain i finalnost;
admin sesijski model (`__Host-`, hash tokena, Origin CSRF, CSP nonce, Access
`aud`/`iss`); Shopify potpisi i `deriveSid` s tajnom; Shopify ne označava
underpayment plaćenim. Detalji u §D/„Što je dobro" u svakom dokumentu.

## Konvencija

ID-evi su stabilni i referiraju se iz `implementation-plan.md`. Kad Opus zatvori
nalaz, dodati `> ✅ Napravljeno <datum> (<PR>)` ispod naslova nalaza, kao u
`../2026-10-fable51/implementation-plan.md` P0-2.
