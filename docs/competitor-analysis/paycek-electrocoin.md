# PayCek (Electrocoin d.o.o.) — Engineering Reference

_Last researched: 2026-05-21_

## 1. TL;DR

- **PayCek** is a Croatian crypto-acceptance gateway operated by **Electrocoin d.o.o.** (Zagreb, est. 2014), the first Croatian operator licensed under MiCA by Hanfa (April 2026).
- **Custodial fiat-conversion model**: PayCek holds the receiving crypto wallets, converts crypto to EUR at detection, and settles to the merchant's IBAN via automated SEPA payout when the merchant's EUR balance crosses a configurable threshold (30–1000 EUR).
- **Per-payment receiving address** issued by PayCek (not Solana-Pay-style URIs with reference). Customers have a 15-minute window to send the exact amount on the chosen chain; PayCek monitors the address on-chain and confirms.
- **Public REST API** at `https://paycek.io/processing/api/*` with **HMAC-SHA3-512 request signing** (`ApiKeyAuth-Key` / `-Nonce` / `-MAC` headers). Same scheme is used to authenticate webhook callbacks. Official SDKs exist for JS and C#.
- **Merchant fee = 0** by default — the transaction fee is charged to the buyer (optionally split). Supports 50+ assets across Bitcoin, Ethereum (+L2s), Solana, Tron, XRP, Stellar, NEAR, EOS, Cardano, etc., including stablecoins (USDC, USDT, DAI, EURC).

## 2. Company background

- **Legal entity:** Electrocoin d.o.o., Zagreb, Croatia. Founded 2014. Croatia's first Bitcoin exchange operator.
- **Distribution footprint:** Historically offered cash exchange through ~55 Hrvatska Pošta (Croatian Post) branches and In Kapital exchanges; turnover ~EUR 30 M by 2018.
- **Regulatory status:** Previously a VASP registered under the Croatian AML/CFT Act. On **2026-04-10** Hanfa (Croatian Financial Services Supervisory Agency) issued Electrocoin Croatia's **first MiCA Crypto-Asset Service Provider (CASP) licence**, authorising: crypto-to-fiat exchange, crypto-to-crypto exchange, custody of crypto-assets, and asset management on behalf of clients.
- **Sister products:** Electrocoin exchange (bitkonan-lineage), and a network of physical exchange points.

## 3. Product overview

PayCek is a **merchant-facing crypto checkout** that takes a fiat-denominated invoice (EUR amount) and lets the buyer pay in any supported crypto. PayCek absorbs price risk and settles to the merchant in EUR.

**Channels offered:**

- **Web POS** (browser-based, no integration required)
- **E-commerce plugins:** WooCommerce, Magento, OpenCart
- **REST API** for custom storefronts and physical POS terminals
- **Invoice payments** (added late 2024)

**Known merchants / integrations:**

- **Konzum** (largest Croatian supermarket chain, online store, 9 cryptocurrencies — December 2021 launch)
- **Hrvatska Pošta** (Croatian Post)
- **Tifon** petrol stations (first Croatian fuel retailer to accept crypto at the pump)
- **entrio.hr** (ticketing platform — this is where the user encountered PayCek choosing SOL)
- **Hotel Split**, **Greyp Bikes**, ~20+ other merchants listed on `paycek.io/shops`

## 4. The per-payment address flow (engineering deep-dive)

What the user observed on entrio.hr — "PayCek creates an empty address per payment and verifies when crypto arrives" — matches PayCek's documented flow. Mechanically:

1. **Merchant opens a payment** server-side by calling `POST /processing/api/payment/open` with `profile_code` and `dst_amount` (EUR). PayCek responds with a `payment_url` (hosted checkout page) and a `payment_code`.
2. **Buyer picks a `src_currency`** (the crypto they want to pay in) on the hosted page. The chosen currency can also be set programmatically via `POST /processing/api/payment/update` with `src_currency` (e.g. `SOL`, `BTC`, `USDC@ETH`, …).
3. **PayCek allocates a receiving address on the chosen chain** and computes the crypto-denominated amount at the current rate. The address is shown to the buyer with a QR/URI plus a **15-minute payment window**.
4. **On-chain monitoring**: PayCek watches the address and matches the incoming transfer by amount. Fast chains (Solana, Tron, XRP, Stellar, EOS, NEAR) settle in 30 s–1 min; slow chains (BTC, ETH, LTC, etc.) take minutes to ~10 minutes for the required confirmations.
5. **Conversion to EUR happens immediately** on detection ("_Izmjena iz kripta u EUR se odvija odmah nakon detekcije kriptovalute na našem novčaniku_") — PayCek/Electrocoin bear FX risk during the 15-minute window and short conversion latency.
6. **Status callbacks** are POSTed to the merchant's `success_url_callback`, `fail_url_callback`, and/or `status_url_callback` URLs, signed with the same HMAC scheme as outbound calls.
7. **Settlement to merchant**: EUR accrues on a PayCek profile. An **automatic SEPA payout** is triggered when the balance crosses a merchant-defined threshold (min 30 EUR, max 1000 EUR per cycle). Manual withdrawals are also possible via `profile/withdraw`.

**Custody model:** Fully **custodial**. PayCek controls the private keys to every receiving address. The merchant never touches crypto. This is a classic on-chain-watcher + omnibus-wallet architecture, the same family as BitPay, NowPayments, CoinGate, Coinbase Commerce.

**Address allocation strategy:** Not explicitly documented in public sources, but the per-payment uniqueness + per-chain support strongly implies HD-wallet derivation (BIP32-style) on UTXO chains and either fresh externally-owned accounts or memo/tag matching on Solana/XRP/Stellar. Could not verify the exact derivation scheme from public sources.

## 5. API & integration

**Base URL:** `https://paycek.io/processing/api`

**Authentication:** API Key + Secret pair (per profile). Every request carries three headers:

| Header             | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| `ApiKeyAuth-Key`   | API key (plaintext)                                                  |
| `ApiKeyAuth-Nonce` | Millisecond Unix timestamp as decimal string                         |
| `ApiKeyAuth-MAC`   | `SHA3-512` hex digest over the canonical request (see formula below) |

**MAC formula** (taken verbatim from `electrocoin-eu/paycek-js/index.js`):

```
SHA3_512(
  "\0" || api_key
  "\0" || api_secret
  "\0" || nonce_string
  "\0" || http_method        // "POST" for all API calls
  "\0" || endpoint_path      // e.g. "/processing/api/payment/open"
  "\0" || content_type       // "application/json" for calls; empty for some webhooks
  "\0" || body_bytes
  "\0"
)
```

The same function verifies inbound webhooks (`Paycek.checkHeaders`).

**Endpoints (POST, JSON):**

| Endpoint                       | Purpose                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `payment/open`                 | Create a payment. Required: `profile_code`, `dst_amount`. Optional: `payment_id`, `items`, `email`, `success_url`, `fail_url`, `back_url`, `success_url_callback`, `fail_url_callback`, `status_url_callback`, `description`, `language`, `generate_pdf`, `client_fields`. Returns `payment_url` and `payment_code`. |
| `payment/get`                  | Fetch current state for a `payment_code`.                                                                                  |
| `payment/update`               | Set `src_currency` (and optional `src_protocol`) on an existing payment — used when the buyer chooses the crypto.          |
| `payment/cancel`               | Cancel an open payment.                                                                                                    |
| `profile_info/get`             | Fetch merchant profile info.                                                                                               |
| `profile/withdraw`             | Trigger a SEPA payout. Required: `method`, `amount`, `details` (`iban`, `purpose`, `model`, `pnb`).                        |
| `account/create`               | Create a merchant account programmatically.                                                                                |
| `account/create_with_password` | Same with password.                                                                                                        |
| `reports/get`                  | Pull transaction reports by date range, optionally by `location_id`.                                                       |

**Webhook security note (significant):** PayCek runs an **automated integration security test** on every new payment — it fires a deliberately invalid-MAC request at every callback URL. If the merchant endpoint returns anything other than `401 Unauthorized` for the bad request, **all in-flight payments are cancelled and the profile is blocked**. This is unusual in the payments space and worth noting if MPT ever offers a similar product. Test profiles are exempt from blocking but still suffer cancelled payments.

**SDKs:** `electrocoin-eu/paycek-js` (npm `paycek`) and `electrocoin-eu/paycek-cs` (NuGet `Paycek`). MIT-licensed, very thin wrappers.

## 6. Supported assets

**Fiat (settlement):** EUR only (HRK was retired with Croatia's euro adoption).

**Crypto (acceptance), 50+ assets across these chains:**

- Bitcoin, Litecoin, Bitcoin Cash, Dogecoin (UTXO)
- Ethereum + ERC-20s (USDC, USDT, DAI, TUSD, EURC, LINK, UNI, PEPE, SHIB)
- Arbitrum, Optimism (L2 ETH)
- Solana, Tron (TRC-20 USDT), Cardano, Polkadot
- XRP, Stellar, EOS, NEAR (memo/tag-based)

## 7. Pricing

- **Account opening / monthly: free** for merchants.
- **Transaction fee: 0%** to the merchant by default. The fee is loaded onto the buyer (a small markup added to the crypto amount). Optional split between buyer and merchant.
- Minimum transaction: 0.01 EUR. Maximum: legal/AML limit per profile.
- Withdrawal: free; automatic SEPA when balance ≥ merchant-chosen threshold (30–1000 EUR).

Could not find the exact buyer-side spread/markup percentage from public sources.

## 8. Settlement & custody model

- **Custodial throughout**: PayCek holds receiving addresses, executes immediate crypto→EUR conversion on its own books (likely against Electrocoin exchange liquidity), and warehouses the EUR balance per merchant profile until SEPA payout.
- **Settlement currency: EUR**, paid to the merchant's IBAN via SEPA.
- **FX risk: PayCek's, not the merchant's** — this is the headline pitch. Risk window is the 15-minute payment validity plus the on-chain confirmation lag.
- **MiCA implications (post-Apr 2026):** Electrocoin now operates as a regulated CASP for custody and exchange, so the custodial model is explicitly licensed — not a grey-zone VASP arrangement.

## 9. Comparison to MPT

| Dimension              | PayCek                                                                  | MPT (mpt.hr)                                                                       |
| ---------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Direction**          | Crypto → Fiat (buyer pays crypto, merchant gets EUR)                    | Fiat → EURe (sender pays EUR via SEPA/Revolut, recipient gets EURe on Gnosis)      |
| **Target user**        | Croatian merchants (retail, e-commerce, ticketing, fuel)                | Croatian wallet users / orgs (e.g. ITalk Gnosis address) needing to fund a Safe    |
| **Custody**            | Fully custodial — PayCek holds keys, holds EUR balance                  | Non-custodial of the destination wallet; minting custody is Monerium's (regulated) |
| **On-chain footprint** | One throwaway address per payment, monitored off-chain                  | EURe mint to Safe + Zodiac Roles forward to recipient — auditable on Gnosis        |
| **Chains supported**   | 10+ L1s + L2s (BTC, ETH, SOL, TRX, etc.)                                | Gnosis chain only (EURe)                                                           |
| **Settlement asset**   | EUR fiat (SEPA payout)                                                  | EURe (Monerium-issued e-money token, 1:1 EUR-backed)                               |
| **Merchant fee**       | 0% to merchant, fee on buyer                                            | Pass-through Monerium fees + ITalk routing fee (TBD)                               |
| **KYC posture**        | KYB on merchant; light KYC on buyer (per Hanfa/MiCA rules)              | KYC handled by Monerium for the EUR→EURe leg; recipient address is opaque         |
| **Regulatory wrapper** | Hanfa CASP licence (MiCA, April 2026)                                   | Relies on Monerium's EE EMI licence; ITalk is a tech operator, not a CASP          |
| **Integration model**  | REST API + hosted checkout + WooCommerce/Magento/OpenCart plugins       | EPC QR / HUB3 QR + backend forwarder; no merchant SDK yet                          |
| **Reversibility**      | Crypto → EUR conversion locked in at detection; merchant gets fiat only | EURe stays on-chain; recipient controls a Safe and can off-ramp via Monerium       |

**Strategic read:**

- **Markets barely overlap.** PayCek serves Croatian retail accepting crypto from international customers, ending in EUR. MPT serves Croatian SEPA-payers wanting EURe on-chain, ending in a smart-contract wallet. Different user, different direction.
- **PayCek is a useful reference for the custodial polarity** — what MPT explicitly avoids. PayCek's auto-EUR conversion is its moat (no merchant FX risk); MPT's selling point is the opposite (the user _wants_ on-chain euros, not fiat).
- **API design lessons worth borrowing:** the HMAC-SHA3-512 nonce scheme is clean and language-portable; the active integration-security test on callback endpoints is a notable hardening pattern (and would discourage casual implementations).
- **Regulatory benchmark:** Electrocoin's MiCA CASP licence (the first in Croatia) sets the bar for any future Croatian competitor in the custody/exchange lane. MPT's current architecture sidesteps this by being non-custodial and leaning on Monerium's EMI licence for the fiat-on-ramp leg.

## 10. References

- [paycek.io — homepage](https://paycek.io/) (accessed 2026-05-21)
- [paycek.io/faq](https://paycek.io/faq) (accessed 2026-05-21)
- [electrocoin.eu/en/payment-processing](https://electrocoin.eu/en/payment-processing) (accessed 2026-05-21)
- [GitHub: electrocoin-eu/paycek-js](https://github.com/electrocoin-eu/paycek-js) — official JS SDK (accessed 2026-05-21)
- [GitHub: electrocoin-eu/paycek-cs](https://github.com/electrocoin-eu/paycek-cs) — official C# SDK (accessed 2026-05-21)
- [Croatia Week — "Croatia issues first crypto licence under MiCA as Electrocoin gains full approval"](https://www.croatiaweek.com/croatia-first-mica-crypto-licence-electrocoin/) (accessed 2026-05-21)
- [Cointelegraph — Konzum + PayCek launch (Dec 2021)](https://cointelegraph.com/news/croatia-s-largest-supermarket-chain-now-accepts-crypto) (accessed 2026-05-21)
- [Shipshape Solutions — PayCek integration overview](https://shipshape-solutions.com/en/blog/payment-in-cryptocurrencies-paycek) (accessed 2026-05-21)
- [paycek.io/static/assets/docs/en/PayCekUserGuide.pdf](https://paycek.io/static/assets/docs/en/PayCekUserGuide.pdf) — official user guide (binary; not parsed inline)
- API documentation portal: `https://paycek.io/api/docs` — referenced in SDK READMEs but returns a footer-only page to anonymous fetches; full docs likely behind merchant login.

### Gaps in public information (flagged uncertainties)

- Exact address-derivation scheme per chain (HD-wallet path, or pooled-address-with-memo for SOL/XRP/XLM) is not publicly documented.
- Exact buyer-side spread / markup percentage above mid-market FX is not published.
- Payment-state lifecycle (status enum values returned by `payment/get`) is not on the public docs page; would need a merchant test account to enumerate.
- Whether PayCek does an internal book swap or routes via the Electrocoin exchange order-book for the crypto→EUR conversion is not disclosed.
