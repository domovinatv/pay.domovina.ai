# Aircash: developer and partner integration surface

Research date: 2026-10-10. Sources are listed at the end.
Labels: **VERIFIED** means a primary source (Aircash's own site, or Aircash's own published plugin code). **REPORTED** means a third-party source (a PSP or gateway's docs). **UNKNOWN** means not found.

## TL;DR

- **There is no public developer portal.** `developers.aircash.eu`, `developer.aircash.eu`, `docs.aircash.eu`, `api.aircash.eu`, `partners.aircash.eu` and `portal.aircash.eu` do not resolve. `github.com/aircash` exists but has 0 public repos ("Coming soon...", last updated 2020). No Swagger was found on the API hosts. (VERIFIED by probing)
- **The best readable spec is Aircash's own WooCommerce plugin**, `aircash-for-woocommerce` v2.0.9 on WordPress.org (updated 2026-09-10, author "aircash", GPLv2). It contains the full Aircash Pay flow: endpoints, RSA-SHA256 signing, callback verification, status codes, refunds, and staging versus production hosts. (VERIFIED, Aircash-authored code)
- **The staging environments are public endpoints, but access is approval-gated.** Merchants generate their own RSA keypair and send an `ActivatePartner` request to staging. Aircash staff approve it manually. Testers must request a special test build of the Aircash app plus funded test users. There is no fully self-serve "sign up, get keys" sandbox like Monerium's. (VERIFIED from plugin + REPORTED by PXP)
- **Merchant fees for Aircash Pay are not published.** Marketing only says "No setup costs / No monthly fees" and "funds are transferred to you instantly". No per-transaction rate or settlement schedule was found anywhere. (VERIFIED absence)
- **Abon (voucher) and Withdrawal/payout APIs** are documented only through PSPs: PXP/Kalixa and Nuvei. They target gaming/betting-style "online account top-up" merchants. (REPORTED)
- **Bill scanning:** the app's Scan&Pay pays Croatian, Slovenian, Austrian and Romanian bills that have "a QR code or barcode", fee-free, and they arrive by the next business day. HUB3/PDF417 and EPC are never named explicitly. (VERIFIED quote; specific formats UNKNOWN)

---

## 1. Aircash Pay (merchant checkout) — API reconstructed from the official plugin

Source: `https://downloads.wordpress.org/plugin/aircash-for-woocommerce.zip`, file `includes/class-aircash-payment-gateway.php` (VERIFIED, Aircash-authored).

### 1.1 Two API generations and their hosts

| | API v1 ("M3", QR in merchant page) | API v2 ("Frame", redirect to Aircash-hosted page) |
|---|---|---|
| Production | `https://m3.aircash.eu` | `https://svc-frame-api.aircash.eu` |
| Staging | `https://staging-m3.aircash.eu` | `https://stage-frame-api.aircash.eu` |

Code: `return $test_mode ? 'https://stage-frame-api.aircash.eu' : 'https://svc-frame-api.aircash.eu';`

Both staging hosts are reachable from the public internet. An unauthenticated `POST /api/v3/status` with `{}` to `stage-frame-api` returned `400 {"code":3,"message":"PartnerTransactionId cannot be empty."}`. The hosted payment UI lives at `frame.aircash.eu`.

### 1.2 Authentication and signing (VERIFIED)

- Each merchant (Partner) has a `PartnerId` (GUID) and **its own RSA keypair**. The plugin generates the keypair locally and sends the public certificate to Aircash:
  - `openssl_pkey_new`, then a self-signed X.509 cert (SHA-256, valid 10 years).
  - The cert is passed as `PublicKey` in `ActivatePartner`.
- **Request signature:**
  1. Take the request parameters in a defined order (alphabetical in v1).
  2. Build a query string, `urldecode(http_build_query($params))`, giving `Key1=val1&Key2=val2...`.
  3. Sign it with **RSA-SHA256** (`openssl_sign(..., OPENSSL_ALGO_SHA256)`) using the merchant's private key.
  4. Base64-encode the result.
  5. Put it in a `Signature` field inside the JSON body. There are no auth headers and no OAuth.
- **Response and callback signatures** are verified with Aircash's X.509 public certificates, which ship in the plugin:
  - v1: `aircash-public-key.pem` / `-test.pem`
  - v2: `aircash-frame-public-key.pem` / `-test.pem`
  - Note: these certs are self-signed and **expired years ago** (for example, notAfter Feb 2022). Expiry evidently isn't checked; the cert is used only as a key container.
- Gateways corroborate this. Rebilly lists the required credentials as "Partner ID, Private key, Private key password" (REPORTED).
- Observations from the plugin code:
  - It calls with `'sslverify' => false`.
  - It embeds a shared "platform" private key (encrypted, with its password in base64 right next to it). That key is used to sign `ActivatePartner` requests on behalf of all WooCommerce installs.
  - This is a weak security posture. We should not copy it.

### 1.3 v2 flow (current default): Initiate, redirect, notification, status pull

**`POST {frame}/api/v2/initiate`** (JSON body):

```
PartnerId, PartnerUserId (merchant-side user GUID), PartnerTransactionId (merchant ref, unique),
Amount (float, 2dp), CurrencyId (ISO-4217 numeric: EUR=978, BGN=975, RON=946, CZK=203,
PLN=985, SEK=752, CHF=756, HUF=348, BAM=977), PayType=0, PayMethod=2,
NotificationUrl, SuccessUrl, DeclineUrl, CancelUrl, OriginUrl, Locale ("hr-HR"),
Signature, [CustomParameters: [{Key, Value}]]  (added after signing)
```

The response is `200 {"url": "..."}`, and the shopper is redirected there. The Aircash frame shows a QR code on desktop and a deeplink button to the app on mobile.

**Notification (webhook):**
- Aircash calls `NotificationUrl` with `?partnerTransactionId=...` in the query string. It sends **no signed payload**; it is a "go check" ping.
- The merchant must then call the status endpoint and verify the signature on its response. This is the same pull-on-ping pattern as our Monerium reconcile path.

**`POST {frame}/api/v3/status`**:
- Request: `{PartnerId, PartnerTransactionId, Signature}`.
- Response fields used: `aircashTransactionId`, `amount`, `currencyId`, `status`, `parameters[{key,value}]`, `signature`.
- Signed string verified against the frame cert:
  `AircashTransactionId=..&Amount=..&CurrencyId=..&Parameters=Key=k&Value=v...&Status=..`
- Status codes, quoted from the code comment:
  > `0 - transaction not processed, 1 – declined, 2 - success, 3 - cancelled, 4 - payoutConfirmationPending, 5 - payoutCancelledByMerchant` — "The final status of transaction is one of: 1, 2, 3, 5"
- Error codes `1002` and `1` are treated by the plugin as "cancel order".
- Statuses 4 and 5 show that **the same Frame API also does payouts** (merchant to user, with a merchant confirmation step).

**Refund v2:**
- Endpoint: `POST {frame}/api/v1/RefundTransaction`
- Body: `{PartnerId, PartnerTransactionId, RefundPartnerTransactionID (new GUID), Amount, Signature}`
- **Partial refunds are supported**: an arbitrary amount can be sent, and the changelog mentions it.

### 1.4 v1 flow (legacy "M3"): merchant renders the QR itself

- **`POST {m3}/api/AircashPay/GeneratePartnerCode`**
  - Body: `{Amount, CurrencyID, Description, LocationID (shop domain), PartnerID, PartnerTransactionID, Signature}`.
  - Response: `{"codeLink": "..."}`. The merchant renders `codeLink` as a QR code and also uses it as the "Pay with Aircash" href, which works as a deeplink on mobile.
  - So the Aircash QR format is a **proprietary link**, not EPC or HUB3. Its exact host/format is UNKNOWN, because it requires an approved partner to see one.
- **Callback (push, signed):**
  - Aircash POSTs JSON `{partnerID, partnerTransactionID, aircashTransactionID, amount, currencyID, signature}` to `ConfirmTransactionURL`, which the merchant registers at activation.
  - The merchant verifies RSA-SHA256 over `AircashTransactionID=..&Amount=..&CurrencyID=..&PartnerID=..&PartnerTransactionID=..`.
  - The merchant replies `200 {"status":0,"message":"Success"}`.
- **Refund v1:** `POST {m3}/api/AircashPay/RefundTransaction` with `{PartnerID, PartnerTransactionID, RefundPartnerTransactionID, Amount, Signature}`.

### 1.5 Onboarding / sandbox (VERIFIED from plugin readme and code)

1. **Register.** The merchant (or the plugin) generates a keypair and calls `POST {m3|staging-m3}/api/AircashPay/ActivatePartner`:
   - Body: `{PlatformID, PartnerID, PartnerName, PublicKey, CurrencyID, ConfirmTransactionURL, ContactEmail, PhoneNumber, Note, Signature}`.
   - The request is signed with the *platform* key. A direct integrator would presumably get its own onboarding instead.
2. **Wait for approval.** Approval status is polled with `GET {m3|staging-m3}/api/AircashPay/CheckPartner?partnerId=...`. This is public and unauthenticated; a bogus id returns 500 "Unknow error has occurred."
3. Readme quote: "After your request is approved by Aircash, under 'Check Configuration' you will see 'approved' test account status." This applies to both test and production. Approval is **manual, by Aircash**.
4. **Test app.** PXP reports: "For provider testing, an app for Android or IOS has to be requested from Aircash. The user must be set up, verified by Aircash support, and funded with test money." (REPORTED)

**Conclusion:** the sandbox exists and the API is well defined. However, it is **gated by a human approval plus a special test app build**. It is not self-serve.

### 1.6 Settlement and fees

- Aircash webshops page: "No setup costs", "No monthly fees", "No development required", "funds are transferred to you instantly". (VERIFIED marketing)
- "Instantly" most likely means the merchant's **Aircash merchant balance** is credited. Payout to the merchant IBAN and its schedule are UNKNOWN.
- No public merchant MDR (percentage) was found. The fees page (`aircash.eu/fees`) covers consumer fees only. Pricing is presumably set in the merchant contract. (UNKNOWN)
- Settlement currency: transactions can be in any of the 9 currencies listed in §1.3. Settlement currency is UNKNOWN.
- Merchant portal: the readme says "You can access every transaction with access to the Aircash portal ... download a complete spreadsheet". (VERIFIED)

### 1.7 Other routes to Aircash Pay (no direct contract needed with Aircash's API)

| Route | Notes | Label |
|---|---|---|
| WSPay | "activate AircashPay via the WSPay platform ... without any additional development" | VERIFIED (aircash.eu) |
| Magento plugin | Referenced as free; no Marketplace listing found | VERIFIED mention / listing UNKNOWN |
| Monri | Monri.js "AirCash component" (client secret, then mount, then success/error events), test and prod environments | REPORTED |
| Nuvei | `apmgw_Aircash` APM | REPORTED |
| PXP/Kalixa | Methods 441 (Pay deposit), 442 (Withdrawal), 443/299 (Abon), 444 (Marketplace) | REPORTED |
| Rebilly | Gateway "Aircash", EUR | REPORTED |
| Logos on the business page | Bambora, Nuvei, Sia, TrustPay, ZotaPay, Woo, WSPay | VERIFIED |

---

## 2. Abon (vouchers)

Aircash does not publish a direct Abon redemption API. It is documented by PSPs only. (REPORTED)

**PXP 443 (direct, B2B):**
- `SerialNumber` is a 16-digit voucher code. Only its presence is validated, not its format.
- Optional `PhoneNumber` in MSISDN format, plus optional name/DOB for matching.
- "An Abon voucher payment is initiated without an amount, but **with** the currency!"
- The flow goes `InitiatedByProvider`, then `AuthorisedByProvider` (in-app confirmation is mandatory in DE). The merchant then sends `executePaymentAction` 95030 to execute or 8 to reject, ending in `DepositedByProvider (29)`.
- "No partial redemption."

**PXP 299:** the same, but the redirect flow goes through the Aircash frame.

**Nuvei `apmgw_Abon`:**
- 30+ countries. Currencies: BAM, CZK, DKK, EUR, HUF, MKD, PLN, RON, RSD, SEK.
- `amount=0` means "use voucher value".
- Payments only: "Payouts, refunds, and recurring are not" supported.

**Fit for us:** Abon targets merchants that hold a user account balance (betting, gaming, GSM top-up). A Monerium-style "pay intent by reference" doesn't map well, because the voucher carries a fixed amount and no merchant reference.

## 3. Payout / Withdrawal / "Aircash Frame"

- PXP 442 "Aircash Withdrawal" (REPORTED):
  - The user enters a phone number in the Aircash Frame, then `ConfirmedByCustomer`, then `PendingOnMerchant`.
  - The merchant approves (95030) or aborts (8), ending in `WithdrawnByProvider (20)`.
  - "Aircash will then top up the user's balance". Funds go to the user's Aircash wallet, keyed by phone.
  - Error 3008: "User reached transaction limit or user is blocked."
- Optional name/DOB "matching" is required in AML markets such as DE. A mismatch gives `RefusedByProvider`.
- Aircash's own Frame status enum includes `4 payoutConfirmationPending` and `5 payoutCancelledByMerchant`. That confirms payouts run on the same Frame API (`svc-frame-api`). (VERIFIED)
- "Top-up" product page: "All you need is API integration – we take care of everything else". The user gets a barcode or reference number and pays cash at 200,000+ EU retail points. (VERIFIED marketing; no docs)
- Marketplace (PXP 444): a deposit is initiated from inside the Aircash app's Marketplace and paid to the merchant, with a check that the user exists in the merchant system. (REPORTED)

## 4. Bill payment / HUB3 / EPC / own QR

- Aircash support page (VERIFIED):
  > "Scan the QR code or barcode from the bill"
  > Croatian, Slovenian, Austrian and Romanian bills "can be paid directly in the Aircash app – with no fees"
  > "The payment will be visible to the recipient no later than the next business day"
  > Bills without a barcode/QR "can't be paid in the app"
- By country, the inference is: HR bills use HUB3 PDF417, SI bills use UPN QR, AT bills use EPC/"Zahlschein" QR, RO bills carry their own barcodes. So in practice the app must read **HUB3 PDF417 and EPC-style QR**. However, no Aircash page names HUB3 or EPC. (UNKNOWN as an explicit claim; needs a device test)
- **No API exists for generating bill codes.** A bill payment is an ordinary credit transfer from Aircash to the payee IBAN. It would therefore land at a Monerium IBAN like any SEPA transfer, carrying the HUB3 reference.
- **Implication for our rail:** our existing HUB3/EPC QR already works with Aircash users, with no integration (subject to a device test). Arrival is by the next business day, not instant.
- Aircash's own merchant QR is a proprietary `codeLink` deeplink generated per transaction (§1.4). It is not a static scannable standard.

## 5. Public code to read the API indirectly

| Repo / package | What | Label |
|---|---|---|
| WordPress.org `aircash-for-woocommerce` v2.0.9 (2026-09-10) | Full v1+v2 Pay flow, signing, refunds, status, onboarding | VERIFIED (Aircash-authored) |
| github.com/aircash | Empty org | VERIFIED |
| github.com/ivan-speh/AircashDemoApp | .NET stub (`SignatureService`, empty `Initiate`) | low value |
| github.com/brigit2aa/AircashMerchantDemo | .NET "AircashSimulator" merchant demo (2022), signature + transaction services | low/medium value |
| github.com/KiahJane/AircashCurrencies | Python currency id/code helper (`references/currencies.json`) | low value |
| Magento plugin | Mentioned on aircash.eu; not found on Marketplace or Packagist | UNKNOWN |
| npm/Packagist SDK | None found | UNKNOWN |

## 6. Comparison with Monerium (for our rail)

| | Monerium | Aircash |
|---|---|---|
| Public docs | docs.monerium.com | None. Plugin source + PSP docs only |
| Sandbox | Self-serve | Staging hosts are public, but partner approval is manual and a test app build must be requested |
| Auth | OAuth2 / client creds | Per-partner RSA keypair, RSA-SHA256 over a query-string, `Signature` in the JSON body |
| Webhooks | Signed events | v1: signed push; v2: unsigned ping, then signed status pull |
| Merchant ref | SEPA reference | `PartnerTransactionId` (our intent id fits directly) |
| Refunds | n/a | Partial refunds via API |
| Fees | Public | Not public (contract) |

**Integration verdict:**
- Aircash Pay v2 maps cleanly onto our intent model: `PartnerTransactionId` is the intent id, `NotificationUrl` is a CF Worker route, and `/api/v3/status` drives reconcile. The work is small.
- However, it requires a **merchant contract/onboarding with Aircash**: KYB, manual approval, and unpublished pricing.
- Settlement lands in an Aircash merchant account, not on-chain. A separate sweep to the Monerium IBAN would be needed, and its timing is UNKNOWN.
- Zero-integration path: Aircash users can already pay our HUB3/EPC codes through Scan&Pay bill payment, arriving as SEPA by the next business day.

## Sources

- Aircash webshops (fees/settlement quotes): https://aircash.eu/business/webshops
- Aircash business / onboarding: https://aircash.eu/en-HR/business
- Aircash top-up: https://aircash.eu/business/top-up-solutions-for-your-users
- Aircash bill pay support: https://aircash.eu/en-HR/support/pay-bill-aircash-app
- Aircash fees (consumer): https://aircash.eu/fees
- WooCommerce plugin listing: https://wordpress.org/plugins/aircash-for-woocommerce/
- Plugin source zip: https://downloads.wordpress.org/plugin/aircash-for-woocommerce.zip
- Plugin metadata API: https://api.wordpress.org/plugins/info/1.0/aircash-for-woocommerce.json
- PXP/Kalixa Aircash overview: https://developer.kalixa.com/docs/aircash
- PXP Aircash Pay deposit: https://developer.kalixa.com/docs/aircashpay-deposit
- PXP Aircash Withdrawal: https://developer.kalixa.com/docs/aircash-withdrawal
- PXP Abon direct: https://developer.kalixa.com/docs/aircash-abon-direct-voucher-deposit
- PXP Abon redirect: https://developer.kalixa.com/docs/aircash-abon-voucher
- PXP Marketplace: https://developer.kalixa.com/docs/aircash-marketplace-deposit
- Monri Aircash component: https://docs.monri.com/docs/en/aircash-1
- Nuvei Aircash: https://docs.nuvei.com/?p=148895 ; Nuvei Abon: https://docs.nuvei.com/?p=476101
- Rebilly Aircash gateway: https://rebilly.com/gateways/aircash
- GitHub: https://github.com/aircash , https://github.com/brigit2aa/AircashMerchantDemo , https://github.com/ivan-speh/AircashDemoApp , https://github.com/KiahJane/AircashCurrencies
- Probed hosts (2026-10-10): staging-m3.aircash.eu (200), m3.aircash.eu (403), stage-frame-api.aircash.eu / svc-frame-api.aircash.eu (404 root, live API), frame.aircash.eu (200); developers/developer/docs/api/partners/portal.aircash.eu do not resolve.
