# 03 — Virtualne kartice, PSE i Apple/Google Pay

## Virtualna kartica

- **Besplatna, instantna, auto-aktivirana**: "Cards are automatically created and activated when
  the order is placed." Jedan poziv: `POST /api/v1/cards/virtual` → `201 {cardId}`.
- Bez PIN-a — "the user's phone number is used as second factor authentication for some online
  payments" (zato je GP-ova phone verifikacija obavezna).
- "Virtual cards work either online or tap in presence (with Apple Pay and Google Pay)" —
  uz ogradu "**some regions are not yet available**" (HR status nepoznat → pitanje za GP).
- Max **5 aktivnih kartica** (virtualne + fizičke; voided/lost/stolen se ne broje).
  (Jedan 422 primjer još kaže "(3)" — potvrditi s GP-om.)

Preduvjeti (doslovno iz 422 liste): KYC approved · SoF ispunjen · risk score Green/Orange ·
verificiran telefon · ime bez nevaljanih znakova · adresa postavljena · podržana zemlja ·
GP Safe ispravno konfiguriran · <5 aktivnih kartica · nema postojeće narudžbe u tijeku (409).

## Lifecycle kartice

```mermaid
stateDiagram-v2
    [*] --> Active: POST /cards/virtual<br/>(auto-aktivacija)
    Active --> Frozen: POST /cards/{id}/freeze
    Frozen --> Active: POST /cards/{id}/unfreeze
    Active --> Lost: POST /cards/{id}/lost (terminalno)
    Active --> Stolen: POST /cards/{id}/stolen (terminalno)
    Active --> Void: POST /cards/{id}/void (samo virtualne)
    Active --> Expired: istek
    note right of Frozen: i automatski 3 min<br/>tijekom withdrawala
```

Status kodovi (`GET /api/v1/cards`): 1000 Active, 1006 Pin Blocked, 1009/1199 Void, 1041 Lost,
1043 Stolen, 1054/1154 Expired, 1062 Restricted… `GET /api/v1/cards/{id}/status` →
`{isFrozen, isStolen, isLost, isBlocked, isVoid, statusCode}`.

## PSE — prikaz PAN/expiry/CVV (Partner Secure Elements)

PSE je GP-ov servis koji **izolira PCI scope**: osjetljivi podaci kartice se renderiraju u
**GP-serviranim iframeovima** unutar našeg UI-ja. SDK: `@gnosispay/pse-sdk` (npm), RN varijanta
`@gnosispay/pse-react-native`. Bez PSE-a (permissionless tier) **ne smijemo prikazati broj
kartice** — kartica postoji, ali korisnik je ne vidi.

```mermaid
sequenceDiagram
    participant U as Korisnik
    participant FE as wallet.domovina.ai<br/>(PSE SDK / PSE Frame)
    participant BE as naš backend<br/>(mTLS klijent)
    participant PSE as api-pse.gnosispay.com

    U->>FE: "Prikaži podatke kartice"
    FE->>BE: GET /api/card/ephemeral-token (naša auth!)
    Note over BE: mTLS klijentski cert<br/>CN=gp_<APP_ID><br/>(privatni ključ = tajna razine relayera)
    BE->>PSE: POST /api/v1/ephemeral-token (mTLS)
    PSE-->>BE: {token, expiresAt} — single-use, 60 s
    BE-->>FE: token
    FE->>PSE: PSE SDK init(appId, token, cardId)
    PSE-->>FE: iframe s PAN / expiry / CVV
    Note over U,FE: korisnik čita podatke,<br/>ručno ih upisuje u Apple/Google Wallet
```

Ključne činjenice:
- **Ephemeral token se MORA dohvaćati s backenda** — "An mTLS authentication can only be
  performed from a back-end." Token je single-use, 60 s; generirati novi za svaku upotrebu;
  naš endpoint mora autenticirati NAŠEG korisnika prije izdavanja (procureni token = 60 s prozor
  do tuđeg PAN-a).
- **Cert ceremonija**: mi generiramo EC P-256 ključ + CSR (`CN=gp_<APP_ID>`), CSR ide GP-u kroz
  Partners Dashboard, vraćaju potpisani cert chain.
- **⚠️ CF Workers rizik**: Workers `fetch` ne može prezentirati proizvoljan klijentski cert
  vanjskom originu. Opcije: (a) CF mTLS certificate binding (`wrangler mtls-certificate upload`
  — podržava custom certove, **provjeriti da radi s GP-ovim chainom**), (b) mali Node servis
  (Hetzner/Fly) samo za token-proxy. Faza 3 spike.
- **Styling iframea**: isključivo CSS file koji autoriramo i **šaljemo GP timu** da ga deployaju
  u iframe (`<partner_name>.css`); iteracija kroz devtools pa submit. Elementi:
  `#pse-card-data-container`, `.pse-card-field/.pse-card-label/.pse-card-value`,
  `#pse-set-pin-form`…
- **WebView/PWA put**: RN docs potvrđuju obrazac "PSE Frame = mala HTML stranica na NAŠOJ
  (whitelistanoj) domeni koja učita PSE JS SDK i fetcha token s našeg backenda" — referenca
  `github.com/gnosispay/ui/blob/main/pse-backend-demo/src/static/native-webview.html`. Isti
  obrazac radi za naš React PWA i budući native app.
- **PIN**: virtualnoj kartici ne treba. (Za fizičke: PSE mijenja samo *online* PIN; offline PIN
  se sinkronizira tek operacijom na bankomatu — support-script detalj.)
- Stari encryption flow (`GET /user/card-public-key`, `POST /cards/verify`, `pinData`) je
  **deprecated** — ne koristiti, drži nas izvan PCI scopea.

## Apple Pay / Google Pay — realno stanje

**Push provisioning NIJE u javnoj dokumentaciji.** Grep cijelog docs cachea: jedina dva spomena
Apple/Google Paya su u opisu virtualnih kartica. Nema `PKAddPaymentPassViewController`, nema
Google TapAndPay, nema wallet-provisioning endpointa.

Što to znači za nas:

| Put | Izvedivost | Napomena |
|---|---|---|
| **Ručni unos PAN-a iz PSE-a u Wallet** | ✅ jedini dokumentirani put | korisnik prepiše broj/expiry/CVV u Apple Wallet ("Add Card → Enter Card Details Manually") / Google Wallet; tokenizacija ide kroz issuera (Monavate) |
| Push provisioning iz PWA | ❌ nemoguće | Apple entitlement `payment-pass-provisioning` ne postoji za web |
| Push provisioning iz native appa | ❓ | zahtijeva i Apple entitlement (restriktivan, ide kroz issuera) i GP-ovu partner podršku koja nije dokumentirana → **pitanje za GP call** |

**UX plan**: nakon izdavanja kartice prikazati vodič "Dodaj u Apple Pay" s PSE prikazom +
koracima za ručni unos (3 ekrana, hrvatski). Jednom dodana u Wallet, kartica radi beskontaktno
na svakom POS-u — *cilj iz vizije je ostvariv i bez push provisioninga*, samo je prvi unos ručni
(~1 min).

**Otvoreno pitanje #1 za GP**: je li Apple Pay / Google Pay tokenizacija njihovog BIN-a
**omogućena za Hrvatsku** ("some regions are not yet available")? Bez toga tap-to-pay ne radi i
ostaje samo online plaćanje. → empirijski test čim prva kartica bude izdana.

## Cashback (sekundarno)

`GET /api/v1/cashback` → `{isOg, gnoBalance, cashbackRate (0–5%), weeklyCapUsd}`. Rate ovisi o
GNO balansu **u GP Safe-u** + OG NFT bonus; bez GNO = 0%. (Poznato iz ranije analize: cashback
je GNO subvencija, ne yield.) Ne gradimo ništa u v1 osim read-only prikaza ako je trivijalno.

## Fizičke kartice (kasnije, van scopea v1)

30.23 EURe, order state machine (`PENDINGTRANSACTION→…→READY→CARDCREATED`), plaćanje EURe
transferom na `0x3D4FD6a1…` (docs citiraju **EURe V1** adresu!), kupon `GPDOCS` za besplatnu
karticu u testiranju, shipping samo u KYC zemlju, ENS personalizacija ≤24 znaka.
