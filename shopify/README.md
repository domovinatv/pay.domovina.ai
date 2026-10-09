# MPT za Shopify (put B: ručni način plaćanja + automatika)

Svaki Shopify trgovac može primati SEPA uplate preko MPT-a bez da Shopify
odobri payment partnera. Kupac odabere ručni način plaćanja „Plaćanje QR
kodom (MPT)“. Na Thank-you stranici i na stranici statusa narudžbe prikaže
mu se EPC QR. Kad novac stigne na Safe trgovca, narudžba se sama označi
plaćenom.

Pozadina i usporedba s pravim payment appom (put A): [docs/integrations/shopify-woocommerce-gateway.md](../docs/integrations/shopify-woocommerce-gateway.md).

## Dijelovi

| Dio | Što radi |
|---|---|
| `shopify.app.toml` | Shopify app konfiguracija: scopes `read_orders,write_orders`, webhookovi `orders/create`, `app/uninstalled` i GDPR |
| `extensions/mpt-payment-qr/` | Checkout UI extension (Preact, API 2026-07): `purchase.thank-you.block.render` i `customer-account.order-status.block.render`. Prikazuje nativni `s-qr-code`, IBAN i opis plaćanja te status uživo. Za narudžbe koje nisu plaćene MPT-om ne prikazuje ništa |
| `worker/` | CF Worker `mpt-shopify.domovina.ai`: OAuth instalacija, Shopify i MPT webhookovi, API za extension, operatorski `/admin`, cron svake 2 min. D1 baza `mpt_shopify` |

Backend (`backend/`) se **ne mijenja**. Worker je običan klijent intent API-ja s
tenant ključem i prima outbound webhookove tenanta (ADR 0017).

## Tok

```mermaid
sequenceDiagram
  autonumber
  participant K as Kupac
  participant S as Shopify
  participant W as mpt-shopify worker
  participant M as MPT backend
  K->>S: checkout, način „Plaćanje QR kodom (MPT)“
  S->>W: orders/create (HMAC)
  W->>S: Admin GraphQL: iznos, gateway
  W->>M: POST /api/intents (x-mpt-key, sid = HMAC(shop, order))
  K->>W: Thank-you extension: GET /ext/order (session token)
  W-->>K: EPC QR + status (poll 5 s)
  K->>M: SEPA Instant iz banke / Revoluta
  M->>W: payment.received → tag mpt-zaprimljeno
  M->>W: intent.paid (Standard Webhooks potpis)
  W->>M: GET /api/intents/:sid (autoritativno)
  W->>S: orderMarkAsPaid + metafields mpt.tx_hash + tag mpt-placeno
```

Ako se extension i `orders/create` utrkuju, oba izvode isti sid. Onaj koji
stigne drugi dobije 409 i samo pročita postojeći intent. Ako webhook ne stigne,
cron svake 2 minute pita intent API.

### Pravila statusa

- **paid**: `paid_at` postoji (on-chain potvrđen forward) i primljeni iznos je ≥ iznosa narudžbe. Tek tada ide `orderMarkAsPaid`.
- **underpaid**: stiglo je manje novca. Narudžba se **ne** označava plaćenom, dobiva tag `mpt-manjak` i rješava je čovjek.
- **received**: Monerium drži novac. Narudžba dobiva tag `mpt-zaprimljeno`, a kupac vidi „zaprimljeno“, uz napomenu o mogućem pregledu ako je prva uplata s tog IBAN-a.
- **expired**: intent je istekao (zadano 24 h). Narudžba dobiva tag `mpt-isteklo`, ili se otkazuje s povratom zalihe ako je `auto_cancel` uključen.
- **Kasna uplata nakon isteka** (`payment.late`) i dalje označava narudžbu plaćenom. Ako je narudžba već otkazana, dobiva tag `mpt-placeno-nakon-otkazivanja` i treba povrat ili ponovnu aktivaciju.
- **rejected**: Monerium je odbio uplatu i vraća novac. Tag `mpt-odbijeno`.

Status se uvijek čita iz intent API-ja. Tijelo webhooka je samo okidač.

## Jednokratni setup (mi)

1. **Shopify app**: u Dev Dashboardu (Partner račun) napraviti app, ili
   `cd shopify && npx shopify app config link`. `client_id` upisati u
   `shopify.app.toml` i u `worker/wrangler.toml` (`SHOPIFY_API_KEY`).
2. **Worker**:
   ```bash
   cd shopify/worker && npm install
   npx wrangler d1 create mpt_shopify        # id → wrangler.toml
   npm run db:migrate:prod
   for s in SHOPIFY_API_SECRET TOKEN_KEK SID_SECRET ADMIN_TOKEN; do npx wrangler secret put $s; done
   npm run deploy
   ```
   `TOKEN_KEK`, `SID_SECRET` i `ADMIN_TOKEN` generirati s `openssl rand -base64 32`.
   **`SID_SECRET` se nikad ne rotira**: novi ključ bi postojećim narudžbama izveo drukčije sidove.
3. **Konfiguracija i extension**: `cd shopify && npm install && npm run deploy`.
4. **U Dev Dashboardu zatražiti**:
   - *Protected customer data access*: potreban za `orders/*` webhookove i čitanje narudžbi. Ne trebaju nam ime, email ni adresa.
   - *Network access* za UI extension (`network_access = true`).
5. **Distribucija**: custom distribution po trgovcu ili unlisted. Javno listanje u App Storeu vjerojatno ne bi prošlo review jer pravila zabranjuju appove koji „register transactions through the Shopify API“ mimo payment procesiranja.

## Onboarding trgovca (~30 min)

1. **MPT tenant** (ADR 0017, `/admin` → Tenanti): trgovčev vlastiti Monerium KYB, IBAN, Safe za isplatu na whitelisti.
   - `outbound_webhook_url` = `https://mpt-shopify.domovina.ai/webhooks/mpt`
   - `outbound_webhook_secret` = novi `whsec_…`
2. Trgovac instalira app (link za custom distribution).
3. Trgovac u **Settings → Payments → Manual payment methods → Create custom payment method**:
   - Naziv: `Plaćanje QR kodom (MPT)`. Mora sadržavati `gateway_match`, zadano `MPT`.
   - Dodatne informacije: „Nakon narudžbe prikazat ćemo vam QR kod. Skenirajte ga u aplikaciji banke i narudžba je plaćena.“
4. Trgovac u **Checkout editoru** doda blok „MPT QR plaćanje“ na *Thank you* i na *Order status* stranicu.
5. Mi aktiviramo trgovinu:
   ```bash
   curl -X PUT https://mpt-shopify.domovina.ai/admin/shops/<shop>.myshopify.com \
     -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"mpt_api_key":"<tenant key>","mpt_webhook_secret":"whsec_…","target_address":"0x<Safe>","active":true}'
   ```
   Opcionalno: `gateway_match`, `intent_ttl_seconds` (600–86400), `auto_cancel`.
   Pregled zadnjih narudžbi: `GET /admin/shops/<shop>`. Ručni resync: `POST /admin/orders/<sid>/resync`.
6. Testna narudžba od 1 €, plaćena iz banke. Narudžba treba prijeći u *Paid* i imati metafield `mpt.tx_url`.

## Poznata ograničenja (MVP)

- **Session token ne veže narudžbu.** Svaki kupac iste trgovine s valjanim tokenom može upitati status i QR tuđe narudžbe ako pogodi njezin ID. Vidi iznos, broj narudžbe i QR, ali ne i osobne podatke. Ispravak bi bio vezati narudžbu uz `checkoutToken` ili `sub` iz tokena.
- **Jedan tenant ima jedan outbound webhook URL.** Tenant koji koristi Shopify ne može istodobno slati evente drugom primatelju (npr. pinka). Cron ionako pokriva sve.
- **Povrati su ručni** iz Safea trgovca. Refund u Shopifyju ne pokreće povrat novca.
- **Order status extension** radi samo s novim customer accountsima. S klasičnima kupac QR vidi samo na Thank-you stranici.
- **Refresh tokena**: dva istovremena refresha (cron i webhook) mogu se sudariti. Drugi tada padne, prvi spremi novi token, a sljedeći poziv radi.
- Još nije testirano na stvarnoj trgovini. Unit testovi pokrivaju potpise, izvođenje sida, enkripciju i logiku statusa (`cd worker && npm test`).
