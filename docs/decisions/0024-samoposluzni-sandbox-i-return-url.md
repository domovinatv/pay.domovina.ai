# ADR 0024 — Samoposlužni sandbox tenant (simulirane uplate) i `return_url` na intentu

- **Status:** Proposed (2026-10-12). Plan; kod tek nakon potvrde.
- **Kontekst:** MPT payment provider za Open SaaS (Wasp SaaS starter): upstream prijedlog
  [wasp-lang/open-saas#746](https://github.com/wasp-lang/open-saas/issues/746), kod na
  `stepanic/open-saas` grana `feat/mpt-payment-provider`. Provider koristi isti ugovor kao
  energy.domovina.ai (`lib/mpt-intent.ts`): `POST /api/intents` s `sk_` ključem, kupca šalje na
  `checkout_url`, kredite daje na `intent.paid` / `payment.late` (Standard Webhooks, `whsec_`).
- **Gradi na:** [0016](0016-tenant-payout-whitelist.md) (whitelist) ·
  [0017](0017-multi-tenant-rail.md) (rail po tenantu, onboarding iza Accessa) ·
  [0021](0021-mpt-hr-javni-hostovi-i-api-v1.md) (P9 sandbox host, P8 verzioniranje)
- **Regresijski ugovor:** samo dodaje ponašanje. Produkcijski tenanti, ključevi `pk_`/`sk_`,
  postojeća polja odgovora i stari testovi ostaju nepromijenjeni (`scripts/compat-check.sh`).

## Problem

Cilj: **bilo tko** s Open SaaS-om u developmentu sam dobije ključ i prođe cijeli tok
(intent → checkout → uplata → webhook → krediti), a za produkciju samo zamijeni ključ.

Danas je to nemoguće iz četiri razloga:

1. Tenant nastaje samo u adminu iza Cloudflare Accessa (`tenants/admin.ts`, `railAdmin.ts`).
2. Checkout nema povratak u aplikaciju; kupac ostaje na `/checkout/<sid>`.
3. U lokalnom developmentu webhook ne dolazi do `localhost` bez tunela.
4. `fetchTotalRevenue` u Open SaaS-u nema odakle čitati (nema liste intenta po tenantu).

## Zašto ne pravi Monerium sandbox po developeru

Prvotna ideja bila je tenant s `monerium_env = 'sandbox'`. To ne radi samoposlužno:

| Prepreka | Gdje |
|---|---|
| Svaki tenant rail = **vlastiti** Monerium račun (client_id/secret, profil). Profil je jedinstven po railu. | `tenant_rail`, migracija 0025 |
| Uplata na sandboxu se simulira samo iz **web sesije** vlasnika Monerium računa (`POST /api/treasury/fund` iz konzole ili gumb „Simulate bank transfer“, koji šalje nasumičan memo). Token appa to ne može. | `docs/2026-10-11-funding-po-projektu.md` |
| Način `direct` traži Safe projekta na Chiadu s potpisanom Monerium porukom (`tools/funding`), način `forward` još i Roles, router plin i kapicu. | ADR 0017, `funding-init.mjs` |
| Dijeljeni `italk-sandbox` rail za više developera traži labavljenje `tenant_mismatch` provjere u webhook putu, tj. promjenu koda koji miče novac. | `monerium/forward.ts`, `tenantIsolation.test.ts` |

Developer bi dakle trebao vlastiti Monerium sandbox račun, Safe na Chiadu, xDAI s faucet-a i
naš admin za rail. To nije „Get sandbox key“.

## Odluka

### D1. Sandbox tenant bez Monerium-a: uplate se simuliraju

Sandbox tenant je običan red u `tenants` s oznakom `sandbox = 1` (migracija 0029) i **bez
`tenant_rail` reda**. Uplatu simulira rail sam, kroz isti put kao prava uplata, pa developer
testira točno ono što će dobiti u produkciji: isti oblik intenta, iste događaje, iste potpise.

- Novac ne postoji, lanac se ne dira, Monerium se ne zove. Zato sandbox tenanti mogu živjeti na
  produkcijskom Workeru, a razlog za odvojenu instancu iz ADR 0021 P9 (Worker po zahtjevu bira
  Monerium okruženje, chain i signera) za njih ne vrijedi.
- Bez `tenant_rail` reda tenant je izvan svih cronova (`listRailTenantIds` radi JOIN na
  `tenant_rail`) i izvan `getTenantRail`, koji za njega vraća `null`. Svaki novčani put već
  odbija `null` (fail-closed), pa sandbox tenant ne može slučajno doći do forwarda.
- Pravi Monerium sandbox ostaje za nas (`italk-sandbox`), za testiranje samog raila.

### D2. Testni ključevi: `pk_test_…` / `sk_test_…`

- Isti format kao danas, s umetnutim `test_` (u skladu s ADR 0021 P9).
  `readTenantKey` regex postaje `^(pk|sk)_(test_)?[0-9a-f]{16,}$`.
- Ključ `*_test_` vrijedi **samo** za sandbox tenanta, a ključ bez `test_` samo za produkcijskog.
  Neslaganje = `invalid_tenant_key`. Tako zamjena ključa u Open SaaS-u (`MPT_SECRET_KEY`) jednim
  potezom prebacuje i okruženje, a testni ključ u produkcijskom deployu ne može kreirati pravi
  intent.
- Kad P9 (`sandbox-api.mpt.hr`) jednom dođe, produkcija počinje odbijati `*_test_` po prefiksu,
  a sandbox tenanti se presele ili nanovo izdaju (jednokratni su).

### D3. Samoposlužni endpoint `POST /api/sandbox/tenants`

Ulaz (JSON): `name` (obavezno, ≤ 80 znakova), `webhook_url` (opcionalno, `https://`).

Izlaz, jednom i nikad više:

```json
{
  "tenant_id": "sbx-7f3a9c2e1b",
  "secret_key": "sk_test_…",
  "public_key": "pk_test_…",
  "webhook_secret": "whsec_…",
  "webhook_url": "https://…/payments-webhook",
  "demo_target_address": "0x…",
  "expires_at": "2027-01-10T…Z",
  "docs": "…"
}
```

- `tenant_id` = `sbx-` + 10 hex znakova, generira rail (developer ne bira slug, nema sudara s
  produkcijskim imenima).
- `webhook_secret` generira rail (isti `whsec_` oblik kao inbound), šifrira se KEK-om kao
  `outbound_webhook_secret`. Webhook se može postaviti i kasnije:
  `PUT /api/sandbox/webhook` s `sk_test_` ključem (`webhook_url`, opcionalno nova tajna).
- Podaci sandboxa idu u novu tablicu `sandbox_tenants` (tenant_id, outbound_webhook_url,
  outbound_webhook_secret_enc, created_ip_hash, created_at, expires_at), ne u `tenant_rail`.
  `tenants.iban` je NOT NULL, pa se upisuje očito nevažeći placeholder koji se **nigdje ne
  prikazuje** (D5).
- Outbound slanje za sandbox tenanta čita endpoint iz `sandbox_tenants`. Za sve ostale tenante
  ostaje `tenant_rail` / env kao danas.

**Zloupotreba.** Što napadač dobiva: tenant koji ne može primiti ni poslati novac. Rizici su
spam u D1, odlazni webhookovi prema tuđim URL-ovima i checkout stranice na našoj domeni.

| Rizik | Mjera |
|---|---|
| Masovno kreiranje | KV brojač po IP-u (sha256 s pepperom): 5 tenanata / 24 h; globalni strop aktivnih sandbox tenanata (`SANDBOX_MAX_TENANTS`, default 500) → `503 sandbox_full`; WAF pravilo u `docs/runbook/rate-limits.md` |
| Boti | Turnstile, env-gated kao u relayeru (`SANDBOX_TURNSTILE_SECRET`; bez njega fail-open) |
| Odlazni webhook kao „pojačalo“ | Webhook ide samo na događaj koji je developer sam izazvao simulacijom; isti outbox i retry kao danas; https only; strop simulacija po tenantu (100 / 24 h) |
| Phishing preko checkouta | Sandbox checkout nosi crvenu traku „SANDBOX — test, nema stvarne uplate“, nema IBAN-a ni QR-a (D5), `return_url` samo uz `sk_` (D6) |
| Pretvaranje u produkciju | Ne postoji put: `activate`/`resume` u adminu odbija tenanta sa `sandbox = 1`, a sandbox endpointi odbijaju produkcijskog. Produkcija = novi tenant kroz admin, nakon KYB-a kod Moneriuma (ToS §16) |
| Gomilanje | `expires_at` = 90 dana od zadnje aktivnosti; cron briše istekle tenante, ključeve i intente |

### D4. Simulacija uplate: `POST /api/intents/:sid/simulate`

- Radi samo za intent sandbox tenanta (inače `404`, da se ne otkriva postojanje). Ovlast je `sid`,
  kao za status (sandbox nema vrijednost koju bi trebalo štititi), pa gumb na checkoutu radi bez
  ključa.
- Tijelo: `{ "outcome": "paid" | "late" | "underpaid" | "rejected", "amount_eur"?: "…" }`.
  Default `paid` s punim iznosom.
- Isti put kao prava uplata, ništa paralelno: sintetički order `sim_<sid>_<n>` i forward red
  (`status = confirmed`, `error = 'simulated'`, `amount_wei = 0`, bez tx-a), zatim postojeći
  `flipPaidAndNotify` / `markIntentUnderpaid` / `markIntentLate`. Događaji su redom
  `payment.received` → `intent.paid` (ili `payment.late` / `payment.underpaid` /
  `payment.rejected`), s istim id-jevima i potpisom kao u produkciji. SSE i polling vide
  promjenu kao inače.
- Pošiljatelj u payloadu: fiksni testni IBAN (`DE89370400440532013000`, javni primjer iz
  ISO 13616) i ime „Sandbox Payer“.
- Admin pregledi i alarmi preskaču forward redove s `error = 'simulated'`; nijedan Telegram
  alarm ne smije zazvoniti zbog sandboxa.

### D5. Checkout i odgovor za sandbox intent

- `POST /api/intents` za sandbox tenanta preskače whitelist i SR-01 strop po cilju, jer novca
  nema: `target_address` mora biti samo valjana adresa (Open SaaS može poslati
  `demo_target_address` ili bilo što). U produkciji whitelist vrijedi kao i dosad.
- Odgovor ima isti oblik, uz dodatna polja `sandbox: true` i `simulate_url`. `iban`,
  `epc_qr_data` i `hub3_data` su `null`, a `memo` ostaje (sid je u njemu). Nitko ne smije moći
  uplatiti pravi novac na sandbox intent.
- Checkout umjesto IBAN-a i QR-a prikazuje traku SANDBOX i gumbe „Simuliraj uplatu“,
  „Simuliraj premalu uplatu“ i „Simuliraj odbijenu uplatu“. Ostatak (status, timeline, SSE) je
  isti kao u produkciji.

### D6. `return_url` na intentu

- `CreateIntentBody.return_url` (opcionalno), novi stupac `payment_intents.return_url`
  (migracija 0029), vraća se u odgovoru.
- Postavlja se **samo sa `sk_` / `sk_test_` ključem**. Bez ključa ili s javnim `pk_` → `400
  return_url_requires_secret_key`. `pk_` ključevi su javni po dizajnu (ADR 0017,
  `tenants/auth.ts`), pa bi inače bilo tko mogao napraviti checkout na našoj domeni koji šalje na
  phishing stranicu.
- Validacija: apsolutni URL, ≤ 2048 znakova, bez `user:pass@`, bez fragmenta. Shema `https:`;
  `http:` samo za `localhost` / `127.0.0.1` / `[::1]` i samo za sandbox tenanta.
- Checkout dodaje `mpt_sid=<sid>&mpt_status=<paid|expired|cancelled>` na `return_url`:
  - `paid` (ili `settled`): gumb „Natrag u aplikaciju“ i automatski povratak nakon 3 s;
  - `expired`: gumb s `mpt_status=expired`;
  - uvijek vidljiv link „Odustani“ s `mpt_status=cancelled`.
- `mpt_status` u URL-u je samo UX. Aplikacija kredite daje isključivo po webhooku ili po statusu
  koji sama pročita s `GET /api/intents/:sid` (D7). Tako piše i u dokumentaciji.

### D7. Development bez tunela (rupa 3): bez promjene raila

`GET /api/intents/:sid` je dovoljan. Open SaaS ga zove **sa servera** (Wasp action/query u
`CheckoutResultPage`, s `mpt_sid` iz `return_url`), a ne iz preglednika. Zato CORS nije
potreban i `localhost:3000` ne ulazi u `ALLOWED_ORIGINS`. Server kredite daje idempotentno po
`sid`-u, isti kod kao webhook handler. U produkciji webhook i polling rade zajedno, a prvi koji
stigne daje kredite.

### D8. Lista plaćenih intenta (rupa 4): zaseban PR

`GET /api/intents?state=paid&since=<iso>&limit=` samo sa `sk_` / `sk_test_` ključem, filtrirano
po tenantu ključa, kursor po `paid_at`. Oblik stavke = postojeći `intentResponseJson` bez
QR polja. Dovoljno za `fetchTotalRevenue`.

### D9. Javni host (rupa 5)

Open SaaS dokumentacija danas koristi `MPT_API_URL=https://mpt.domovina.ai`. ADR 0021 ga drži
**trajnim aliasom bez redirecta**, pa se ne pokvari kad dođe `api.mpt.hr`. Kad faza 1 ADR-a 0021
ode u produkciju, docs prelaze na `https://api.mpt.hr` + `/v1`, a provider samo mijenja default.
Ključevi `*_test_` već odgovaraju planu iz P9.

## Faze (PR-ovi)

| PR | Sadržaj | Testovi |
|---|---|---|
| **1** | migracija 0029 (`tenants.sandbox`, `sandbox_tenants`, `payment_intents.return_url`); D2 ključevi; D3 endpoint + rate limit + Turnstile; D5 grananje u `POST /api/intents` i checkoutu; D4 simulacija; D6 `return_url`; isključenje simulated redova iz admina i alarma; cron za istek | novi `sandbox.test.ts`, `returnUrl.test.ts`; stari bez izmjena + `compat-check.sh` |
| 2 | D8 lista intenta | `intentList.test.ts` |
| 3 | Open SaaS: polling u `CheckoutResultPage`, `return_url`, `mpt.mdx` („Get sandbox key“ = jedan `curl`), docs/runbook | u `stepanic/open-saas` |

`return_url` (D6) je neovisan o sandboxu i može ići i kao zaseban mali PR prije PR 1, ako
želimo da energy.domovina.ai to dobije odmah.

## Odbačeno

- **Pravi Monerium sandbox po developeru:** vidi tablicu gore.
- **Dijeljeni `italk-sandbox` rail s pod-tenantima:** traži izmjenu tenant izolacije u
  webhook putu (kod koji miče novac) i našu web sesiju za svaku simuliranu uplatu.
- **Odvojeni sandbox Worker odmah (ADR 0021 P9):** ispravan krajnji oblik, ali traži vlastiti
  D1/KV/DO, deploy pipeline i host. Za tenante bez novca i Moneriuma nije potreban sada.
- **`return_url` s `pk_` ključem uz popis dopuštenih origina po tenantu:** više stanja u adminu
  za isti učinak. Ako ga zatraži klijent koji nema server (čisti browser), dodaje se kasnije.
- **Proširiti `ALLOWED_ORIGINS` na `localhost:3000` za polling iz preglednika:** nije potrebno
  (D7), a otvara rail svakom lokalnom originu.
