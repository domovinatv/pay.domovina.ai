# Swan — sandbox probe

- **Datum:** 2026-11-17. Matija je otvorio Swan račun (prijava brojem mobitela), Claude je radio
  probe u dashboardu i API Exploreru.
- **Sandbox projekt:** „ITalk”, `caa91a63-c91a-473d-b880-c76b838bac20` (sandbox; tajne nisu u repou,
  client secret nije generiran).
- **Presuda: GO za sandbox razvoj adaptera.** Otvoreno: format `secret`-a za `x-swan-secret` (G3) i
  partnerski ugovor / skrbništvo (G8). Plan: [provideri-priljeva-sandbox-prvo](../../plans/provideri-priljeva-sandbox-prvo.md).

| Vrata | Rezultat | Dokaz |
|---|---|---|
| G1 samoposlužni sandbox | ✅ | prijava brojem mobitela, sandbox projekt odmah; bez prodaje |
| G2 simulacija dolazne SEPA s opisom | ✅ | Testing API `simulateIncomingSepaCreditTransferReception` (polja `label`, `endToEndId`, `isInstant`, `debtorIban`, `debtorName`); isto u dashboardu, Event Simulator → SEPA Credit Transfers |
| G3 webhook + provjera | ✅ isporuka · ⚠️ tajna | `Transaction.Booked` stigao na produkcijski worker ~2 s nakon knjiženja (fixture `webhook-transaction-booked.json`); pretplata s našom tajnom odbijena (`InvalidArgumentRejection`), bez tajne prošla. Header `x-swan-secret` još nije viđen |
| G4 opis ili vIBAN | ✅ oboje | `label` = naš tekst doslovno (`sid:swanprobe01`); `paymentMethodIdentifier` i `creditor.IBAN` = vIBAN na koji je stiglo |
| G5 platitelj | ✅ | `debtor.name`, `debtor.IBAN` (HR IBAN prolazi), `counterparty` |
| G6 SEPA Instant | ✅ | `type: SepaInstantCreditTransferIn` vs `SepaCreditTransferIn`; `Booked` ~75 ms nakon `createdAt` (sandbox) |
| G7 HR tvrtka | ✅ u sandboxu | onboarding s `residencyAddress.country: HRV` prošao validaciju i verifikaciju; IBAN računa može biti samo FRA/DEU/ESP/NLD/ITA/BEL. Produkcija: Swan kaže „prvi live račun ima francuski IBAN bez obzira na lokaciju” |
| G8 račun je tenantov | ⚠️ | model je ispravan (tenant = account holder, MPT = partner/projekt), ali produkcija traži „Talk to an expert” → standardni ugovori → compliance odobrenje projekta. Cijena i obveze partnera nepoznati |

## Kako je napravljeno (ponovljivo)

Sve preko GraphQL-a. U dashboardu (prijavljen) Explorer zove tri endpointa sa session cookiejem,
`https://dashboard.swan.io/api/projects/<projectId>/…`:

| Uloga | Put | Za što |
|---|---|---|
| projekt (partner) | `sandbox-partner` | onboarding, čitanje računa i transakcija |
| korisnik (account member) | `account-member/sandbox-partner` | `finalizeOnboarding`, `addVirtualIbanEntry` |
| Testing API | `project-member/sandbox-partner-admin` | simulacije (verifikacija, dolazna uplata) |

Za server-side kod isto ide s OAuth2 client credentials (Developers → API). Simulacije su samo u
sandboxu.

1. `onboardCompanyAccountHolder` (`accountCountry: FRA`, HR adresa, `email` ne smije biti
   besplatni provider, npr. `example.com` je odbijen) → `updateCompanyOnboarding`
   (`businessActivity`, `businessActivityDescription`, `monthlyPaymentVolume`, `language`,
   `taxIdentificationNumber`) → status `Valid`.
2. `finalizeOnboarding` (samo kao korisnik; kao projekt: `ForbiddenRejection`) → račun `Opened`,
   IBAN još `null`.
3. Event Simulator → Account holders → Update verification status = `Verified` → račun dobije IBAN
   `FR76 9999 9001 …`, BIC `SWNBFR22`, `paymentLevel: Unlimited`.
4. `addVirtualIbanEntry(accountId)` → vIBAN `FR76 9999 9002 …`, `Enabled`. Jedan poziv, bez
   odobrenja. vIBAN je samo za primanje.
5. `simulateIncomingSepaCreditTransferReception` (Testing API; fragment `... on Rejection` nije
   dopušten u tom servisu) → `transactionId: bosci_…`.
6. `transaction(id)` → fixture u `backend/test/fixtures/swan/`.

## Mapiranje u `CreditEvent` (ADR 0032)

| `CreditEvent` | Swan |
|---|---|
| `provider` | `'swan'` (dodati u union) |
| `providerRef` | `transaction.id` (`bosci_…`) |
| `receivingIban` | `paymentMethodIdentifier` (= vIBAN ili glavni IBAN) |
| `amountCents` | `amount.value` (string, decimalni) × 100 |
| `remittance` | `label` (`labelType: Unstructured`; strukturirani RF bi bio `Structured`, nije testirano) |
| `endToEndId` | `reference` |
| `debtorName` / `debtorAccount` | `debtor.name` / `debtor.IBAN` |
| `scheme` | `type === 'SepaInstantCreditTransferIn'` → `sepa_inst`, inače `sepa` |
| `finality` | `statusInfo.status`: `Upcoming`/`Pending` → `notified`, `Booked` → `booked` (u sandboxu odmah `Booked`) |

Matcher dobiva novi, najjači korak prije sid-a: **vIBAN → intent** (tablica vIBAN-a po intentu ili
po tenantu). Opis se tada koristi samo kao provjera.

## Webhook (G3)

- Subscription: `addWebhookSubscription(label, endpoint, secret, eventTypes[], status)` ili
  dashboard → Developers → Webhooks → New. Postoje i `probeWebhookEndpoint` i `replayWebhookEvent`
  (korisno za testove).
- Po Hookdeckovom vodiču (ne Swanovim docsima): tijelo je samo `eventType`, `eventId`, `eventDate`,
  `projectId`, `resourceId`; Swan ne potpisuje tijelo, nego šalje dijeljenu tajnu u `x-swan-secret`.
  Swan docs: `Transaction.Booked` i `Transaction.Released` mogu stići bilo kojim redom.
- Posljedica za adapter: webhook je samo okidač, kao LHV `GENERAL_WEBHOOK`. Adapter provjeri
  `x-swan-secret` (constant-time), pa **uvijek** dohvati `transaction(resourceId)` partnerskim
  tokenom. Lažni webhook tako ne može ubaciti podatke, može samo izazvati dohvat.
- **Uhvaćen 2026-11-17 bez promjene koda:** pretplata (sandbox) na
  `https://api.mpt.hr/api/monerium/webhook/t/swan-probe-20261117`. Tenant ne postoji, pa ruta
  vrati 404 i spremi prvih 1024 B tijela u `monerium_webhook_events` (`unknown_tenant`). Tijelo:
  `eventId`, `eventType`, `eventDate`, `projectId`, `resourceId` (= `transaction.id`), `retryCount`.
  Headere ta ruta ne sprema. Pretplata `05b475ba-…` je još aktivna; Swan na 404 radi ponovne
  pokušaje (`retryCount`), pa je treba ugasiti ili preusmjeriti na pravu rutu adaptera.
- Ostaje: kakav `secret` Swan prihvaća (naš 32-hex odbijen) i viđeni `x-swan-secret` header.

## Što ostaje za produkciju

- „Talk to an expert” je prvi korak aktivacije; nakon njega standardni ugovori, compliance
  odobrenje projekta, live API, završni pregled integracije.
- Pitanja za Swan: cijena za partnera i po računu/vIBAN-u; može li account holder biti HR d.o.o.
  (G7 u produkciji); potvrda da je novac na računu tenanta i da ITalk kao partner nije skrbnik (G8);
  limit broja vIBAN-a; postoji li SEPA Instant za sve vIBAN-e.
- IBAN je francuski (`FR76…`): HUB3 i HR bankovne aplikacije ne pomažu (matrica B), ali Revolut,
  N26 i EU banke plaćaju normalno, a vIBAN rješava brisanje reference.

## Implementacija (grana `feat/credit-events-inbox`, 2026-11-17)

- Ruta `POST /api/swan/webhook/t/:tenantId` (ADR 0032 §7) → `providers/swan/adapter.ts`:
  provjera `x-swan-secret` ako je postavljen, pa `transaction(resourceId)` tenantovim
  pristupnim podacima; uplata se prihvaća samo ako je `transaction.account.id` tenantov
  `receiving_accounts.external_account_id`.
- `Booked` → `credit_events` → zajednički matcher (`inflow/matcher.ts`) → `inflow/settleFiat.ts`
  (isti put kao sandbox simulacija: sintetski order `swan_<txId>`, forward `confirmed` /
  `fiat_notify`, `settleNonRoutedPaid`). `Pending` se samo upiše (`notified`).
- Registracija računa: `POST /admin/api/tenants/:id/receiving-accounts`
  (`provider: swan`, `environment`, `external_account_id`, `client_id`, `client_secret`,
  opcionalno `webhook_secret`). Tajne se kriptiraju KEK-om i nikad ne vraćaju.
- Pretpostavka koju treba potvrditi prvim živim pozivom: OAuth `https://oauth.swan.io/oauth2/token`
  i GraphQL `https://api.swan.io/sandbox-partner/graphql` (live: `live-partner`).
- Model s jednim Swan projektom za više tenanata: Swan pretplata je po projektu, pa svaki tenant
  dobije svoju pretplatu na svoj URL; tuđe transakcije završe kao `not_this_tenant_account`.

## Produkcijski E2E (sandbox Swan → api.mpt.hr), stanje 2026-11-17

Deployano: PR #148 (`7b89bf4`), migracija 0034 na produkciji, ruta živa
(`POST https://api.mpt.hr/api/swan/webhook/t/<tenant>` → `{"error":"no_swan_account"}` dok tenant
nema Swan račun).

Koraci (tajne upisuje vlasnik, ne agent):

1. **Tenant:** samoposlužni sandbox tenant (ADR 0024):
   `curl -s -X POST https://api.mpt.hr/api/sandbox/tenants -H 'content-type: application/json' -d '{"name":"Swan probe"}'`
   → `tenant_id` (`sbx-…`) i `secret_key` (`sk_test_…`, prikazuje se jednom).
2. **Swan:** dashboard → Developers → API → Generate a new client secret (Client ID + secret).
3. **Registracija:** `/admin/tenants` → odaberi tenanta → „Računi primatelja (ADR 0032)” → Swan,
   sandbox, accountId `b31aae63-2a8f-42ad-a537-542899518fb8`, client_id, client_secret → „+ Dodaj račun”
   (PR #149). Tablica pokazuje webhook URL za Swan pretplatu.
4. **Intent:** `POST /api/intents` sa `sk_test_` ključem tenanta, iznos npr. 12,34 €.
5. **Swan pretplata** `05b475ba-…`: endpoint → `https://api.mpt.hr/api/swan/webhook/t/<sbx-id>`;
   simulirati dolaznu uplatu na vIBAN s opisom `sid:<sid>` → intent `paid`, red u `credit_events`.

### Prvi Swan → `paid` na produkciji (2026-11-17 22:34 UTC) ✅

- Tenant `sbx-d166d9a98b`, receiving account #1 (dodan kroz `/admin/tenants`, #149), intent
  `vmwjxqts8ajj` 12,34 € (kreiran `sk_test_` ključem).
- Swan pretplata `05b475ba-…` preusmjerena na `/api/swan/webhook/t/sbx-d166d9a98b`; pomoćna
  pretplata na example.com obrisana.
- Simulirana SEPA Instant 12,34 € na vIBAN, opis `sid:vmwjxqts8ajj` → transakcija
  `bosci_f0d42e37…` → webhook → OAuth + `transaction(id)` (potvrđeni URL-ovi `oauth.swan.io` i
  `api.swan.io/sandbox-partner/graphql`) → `credit_events` #1 (`matched_by=sid`, `sepa_inst`,
  `booked`) → intent `paid`, `amount_received_cents=1234`, ~1 s nakon knjiženja.
- Otvoreno: vremenska crta statusa na checkoutu još prikazuje Monerium korake (processing,
  minted, forwarding) i za `fiat_notify`; za Swan bi trebala biti „banka → primljeno”.

## Otvoreno (stanje 2026-11-17, nakon #151)

1. **Gumb „Simuliraj uplatu” na checkoutu** je ADR 0024 interna simulacija (`sandbox/simulate.ts`,
   sintetski `sim_` order) i ne ide kroz Swan; intent `2v89mbb5mven` je tako plaćen, a u Swan
   dashboardu ga nema. Za tenanta s aktivnim Swan sandbox računom gumb treba zvati Swanov
   `simulateIncomingSepaCreditTransferReception` (vIBAN, `label: sid:<sid>`), analogno
   `monerium/sandboxFund.ts`. Treba potvrditi Testing API endpoint za client-credentials token
   (u dashboard sesiji je to `project-member/sandbox-partner-admin`).
2. **Vremenska crta statusa** (`intents/stage.ts`) za `fiat_notify` prikazuje Monerium korake.
3. ADR 0032 §1 (Monerium piše u `credit_events`) i §4 (`intent_settlements` umjesto sintetskog ordera).
4. Format Swan webhook `secret`-a (32-hex odbijen s `InvalidArgumentRejection`).
5. Produkcija: „Talk to an expert” kod Swana (cijena, HR d.o.o. kao account holder, skrbništvo — G7/G8).
