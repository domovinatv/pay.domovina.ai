# Shopify + WooCommerce gateway integration — engineering reference

_Compiled: 2026-05-21. Single source of truth for evaluating effort + picking
the integration path for MPT (Mint Pay Transfer) as a checkout payment method
on Shopify and WooCommerce shops. Companion to
[per-event-safe-rail.md](../product-vision/per-event-safe-rail.md)._

## 1. TL;DR

- **Shopify MVP (1–2 days/merchant)**: use Shopify's built-in **Manual
  payment method** (admin → Settings → Payments → "Create custom payment
  method"). At checkout the buyer is told to scan an EPC QR with memo
  `mpt:<safe>?sid=<order_id>`; MPT auto-marks the order paid via the
  Admin GraphQL `orderMarkAsPaid` mutation when the on-chain forward
  confirms. No App Store listing, no Plus restriction, no review.
- **Shopify "proper" path (4–8 weeks)**: build an **Alternative payments
  extension** (not offsite — buyer never leaves Shopify), use
  `paymentSessionPending` while awaiting SEPA settlement, then
  `paymentSessionResolve` on confirmation. Requires Shopify Partner
  approval, signed revenue-share agreement, and is **currently
  invitation-only** + restricted to eligible Plus merchants per
  Shopify's published guidance.
- **WooCommerce MVP (3–5 days, one-time)**: a small PHP plugin
  extending `WC_Payment_Gateway`, modelled on the bundled BACS plugin.
  Sets order to `on-hold`, exposes a `wc-api/mpt_gateway` callback
  endpoint, transitions to `processing`/`completed` on HMAC-verified
  POST from MPT. One plugin reused across all WooCommerce merchants.
- **Both platforms map cleanly to MPT's "wait for off-platform
  settlement" pattern** — the same pattern Klarna Pay Later, manual
  bank transfer (BACS) and Direct Debit already use. No platform
  invention required; MPT just adds on-chain proof + automated
  reconciliation via `sid`.
- **Recommendation**: ship WooCommerce plugin first (one artefact,
  reuses across merchants, no gatekeeper) + Shopify manual-method
  recipe (per-merchant 1-day setup). Defer the Shopify alternative
  payments extension until a Plus merchant prospect appears or volume
  justifies the 4–8 week investment.

## 2. Background

MPT routes SEPA payments into Gnosis-chain EURe via Monerium + Zodiac
Roles. From a webshop's perspective the rail behaves like an "enhanced
bank transfer":

1. Buyer reaches checkout, picks "MPT" as payment method.
2. Webshop displays an EPC QR + IBAN with memo
   `mpt:<merchant_safe_address>?sid=<order_id>` and the EUR amount.
3. Buyer scans with Revolut/bank app and approves SEPA payment.
4. Monerium mints EURe, hits MPT's webhook; MPT routes via the Roles
   Modifier to the merchant's Safe on Gnosis.
5. MPT POSTs `{sid, target, amount_eur, tx_hash, confirmed_at}` to the
   merchant's gateway callback (HMAC-signed).
6. Webshop marks the order paid, releases product / digital good /
   ticket.

This is structurally identical to **entrio.hr ticketing**, **bank
transfer / SEPA Direct Debit**, **Klarna Pay Later**, **manual
proforma invoice** — a known "async settlement" pattern with mature
support in both Shopify and WooCommerce. MPT's only novelty is
auto-reconciliation via the `sid`, which converts what's normally a
manual ops task into a webhook-driven flip.

## 3. Shopify integration paths

Shopify exposes four distinct surfaces for third-party payment
methods. They differ wildly in effort, gatekeeping, and UX.

| Tier | Surface | UX | Eligibility / gatekeeping | Per-merchant setup | Engineering effort |
|---|---|---|---|---|---|
| 1 | **Manual payment method** (admin setting) | Buyer sees method label + instructions on order-confirmation page. Order goes to `payment_status=pending`. Marked paid via Admin API. | Any merchant on any plan. No approval. | ~15 min in Shopify admin + API token issuance | One-time: ~1 day to wire `orderMarkAsPaid` mutation against MPT webhook. Zero per-merchant code. |
| 2 | **Alternative payments extension** (in-checkout, no redirect) | Buyer stays on Shopify checkout, sees QR rendered by partner app, `paymentSessionPending` keeps state until settled. | **Shopify Partner approval + signed revenue-share agreement + currently invitation-only**, eligible Plus merchants only per [requirements](https://shopify.dev/docs/apps/build/payments/requirements). | App install + API key | 4–8 weeks: Shopify CLI extension, GraphQL session mutations, mTLS, 99.95% SLA, 2-hour outage response, App Store-style review. |
| 3 | **Offsite payments extension** (redirect to MPT-hosted page) | Buyer redirected from checkout to an MPT page, scans QR there, returns. | Same as Tier 2. | Same as Tier 2. | Similar effort to Tier 2; only meaningful if we *want* to host the QR off-platform. For MPT we don't. |
| 4 | **Shopify Payment Service Provider** (official tier, listed in Settings → Payments dropdown) | Native, fully integrated. | Highest bar; designed for card processors, country-by-country licensing. Croatia is not currently on Shopify Payments' list of payment-processor regions for new entrants. | n/a | Not applicable to MPT for the foreseeable future. |

### 3.1 Recommended Shopify path: Tier 1 (manual + Admin API)

The manual method surface is **explicitly designed** for bank-transfer
style flows. Per Shopify Help Center: merchants type a custom name and
free-text instructions; orders land in `pending`; merchants then "mark
as paid" in admin. We do exactly that via the API:

- **Mutation**: `orderMarkAsPaid(input: { id: $orderId })` — creates a
  `CAPTURE` transaction, sets `financialStatus = PAID`, zeros balance.
  Requires `write_orders` scope + `mark_orders_as_paid` permission.
  Docs: <https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderMarkAsPaid>
- Alternate, more granular: `orderCreateManualPayment` to record the
  payment with method label "MPT", txn date, amount.
- MPT subscribes to Shopify's `orders/create` webhook to learn the
  order ID and total, then renders the EPC QR with
  `sid=<shopify_order_id>` either via a Shopify theme app extension
  (small JS snippet on order-status page) or via a redirect to a
  hosted `pay.domovina.ai/checkout/<order_id>` page.
- HMAC verification of incoming `orders/create` webhooks via
  `X-Shopify-Hmac-SHA256` header — base64 HMAC-SHA256 of the **raw**
  body with the app's shared secret. Docs:
  <https://shopify.dev/docs/apps/build/webhooks/subscribe/https>.

**Caveat (Shopify gotcha)**: a manual payment method does **not** show
a custom widget inside Shopify checkout itself — the buyer only sees
the method's free-text instructions on the order-confirmation page.
To render the QR *during* checkout we'd need either (a) a checkout UI
extension (separate, lighter than a payments extension), or (b) the
order-status-page theme extension. The simplest MVP: include the QR
URL in the instructions field, so the buyer is redirected on the
"Thank you" page; refine later.

### 3.2 Why not Tier 2 yet

Shopify's [payments platform requirements](https://shopify.dev/docs/apps/build/payments/requirements)
list:

- 99.95% uptime SLA, mTLS, 2-hour outage response window
- Transparent pricing, 7-day merchant exit clause
- Signed revenue-share agreement with Shopify
- "Available by invitation only while we continue to build out our
  Payments Apps API" (per the
  [extension review docs](https://shopify.dev/docs/apps/build/payments/payments-extension-review))
- Eligibility limited to Shopify Plus merchants per
  community + Shopify Partner Support guidance

For a pre-product-market-fit rail this is the wrong cost curve.

## 4. WooCommerce integration architecture

WooCommerce treats payment methods as first-class plugin extension
points. The model is unambiguous and well-trodden:

### 4.1 Classic gateway shape

```php
class WC_Gateway_MPT extends WC_Payment_Gateway {
    public function __construct() {
        $this->id                 = 'mpt';
        $this->method_title       = 'MPT — SEPA via Gnosis';
        $this->method_description = 'Pay by SEPA, settles on-chain in ~10s';
        $this->has_fields         = false;
        $this->init_form_fields();
        $this->init_settings();
        $this->title       = $this->get_option( 'title' );
        $this->description = $this->get_option( 'description' );
        $this->safe_address = $this->get_option( 'merchant_safe_address' );
        $this->shared_secret = $this->get_option( 'mpt_shared_secret' );

        add_action( 'woocommerce_update_options_payment_gateways_' . $this->id,
            array( $this, 'process_admin_options' ) );
        add_action( 'woocommerce_thankyou_' . $this->id,
            array( $this, 'thankyou_page' ) );
        add_action( 'woocommerce_api_mpt_gateway',
            array( $this, 'handle_callback' ) );  // public URL: /wc-api/mpt_gateway
    }

    public function process_payment( $order_id ) {
        $order = wc_get_order( $order_id );
        // Reserve stock, set to on-hold awaiting MPT confirmation
        $order->update_status( 'on-hold',
            __( 'Awaiting MPT SEPA settlement', 'mpt' ) );
        wc_reduce_stock_levels( $order_id );
        WC()->cart->empty_cart();
        return array(
            'result'   => 'success',
            'redirect' => $this->get_return_url( $order ),
        );
    }

    public function thankyou_page( $order_id ) {
        $order = wc_get_order( $order_id );
        $sid   = $order->get_id();
        // Render EPC QR + IBAN block with memo mpt:<safe>?sid=<sid>
        echo $this->render_qr_block( $this->safe_address, $sid,
            $order->get_total() );
    }

    public function handle_callback() {
        // POST from MPT backend, HMAC-signed
        $body = file_get_contents( 'php://input' );
        $sig  = $_SERVER['HTTP_X_MPT_SIGNATURE'] ?? '';
        if ( ! hash_equals( hash_hmac( 'sha256', $body, $this->shared_secret ),
                            $sig ) ) {
            status_header( 401 );
            exit;
        }
        $payload = json_decode( $body, true );
        $order   = wc_get_order( (int) $payload['sid'] );
        if ( ! $order ) { status_header( 404 ); exit; }
        $order->payment_complete( $payload['tx_hash'] );
        $order->add_order_note( sprintf(
            'MPT confirmed on-chain: %s — %s EUR', $payload['tx_hash'],
            $payload['amount_eur'] ) );
        status_header( 200 );
    }
}

add_filter( 'woocommerce_payment_gateways', function( $gateways ) {
    $gateways[] = 'WC_Gateway_MPT';
    return $gateways;
} );
```

This mirrors the bundled **BACS** (`class-wc-gateway-bacs.php`)
implementation — same status flow, same instructions hook, same
return shape from `process_payment`. Bundled BACS source:
<https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/gateways/bacs/class-wc-gateway-bacs.php>.

Key WooCommerce hooks/contracts used:

- `WC_Payment_Gateway` abstract class — extend it; required methods:
  `process_payment( $order_id )`, plus constructor setup of `id`,
  `method_title`, `init_form_fields`, `init_settings`. Docs:
  <https://developer.woocommerce.com/docs/features/payments/payment-gateway-api>
- `woocommerce_payment_gateways` filter — registers the class.
- `process_payment` returns `array('result' => 'success', 'redirect' => $url)`
  or `array('result' => 'failure')`.
- Order status flow: `pending` → `on-hold` (awaiting settlement) →
  `processing` (paid, physical to ship) or `completed` (paid, digital).
  `$order->payment_complete($txn_id)` transitions correctly based on
  cart contents.
- Callback endpoint: register via `add_action('woocommerce_api_<slug>', ...)`,
  public URL is `https://shop.example/wc-api/<slug>`. Docs:
  <https://developer.woocommerce.com/docs/extensions/core-concepts/woocommerce-plugin-api-callback/>

### 4.2 WooCommerce Blocks (modern React checkout)

WooCommerce 8.x ships a Blocks-based checkout by default on new
stores; the classic gateway above will appear but as a fallback. For
first-class Blocks rendering, additionally:

```php
use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

final class MPT_Blocks_Support extends AbstractPaymentMethodType {
    protected $name = 'mpt';
    public function initialize() {
        $this->settings = get_option( 'woocommerce_mpt_settings', [] );
    }
    public function is_active() {
        return filter_var( $this->get_setting( 'enabled', false ),
                           FILTER_VALIDATE_BOOLEAN );
    }
    public function get_payment_method_script_handles() {
        wp_register_script( 'mpt-blocks',
            plugins_url( 'build/index.js', __FILE__ ), [], '1.0', true );
        return [ 'mpt-blocks' ];
    }
    public function get_payment_method_data() {
        return [ 'title' => $this->get_setting( 'title' ),
                 'description' => $this->get_setting( 'description' ) ];
    }
}

add_action( 'woocommerce_blocks_payment_method_type_registration',
    function( $registry ) { $registry->register( new MPT_Blocks_Support() ); } );
```

Plus a small JS bundle calling `registerPaymentMethod` from
`@woocommerce/blocks-registry` (or `window.wc.wcBlocksRegistry`).
Reference:
<https://developer.woocommerce.com/docs/block-development/extensible-blocks/cart-and-checkout-blocks/checkout-payment-methods/payment-method-integration/>

For MPT the JS shows only label + description (no payment fields);
all interaction happens on the `woocommerce_thankyou_mpt` page where
the QR is rendered. So the Blocks bundle is tiny (~50 LOC).

### 4.3 Distribution

- **Phase 1 (recommended)**: standalone ZIP hosted on `pay.domovina.ai`
  with a one-click "download MPT for WooCommerce" button. Merchant
  uploads via WP Admin → Plugins → Add New → Upload. No marketplace
  gatekeeping.
- **Phase 2**: submit to wordpress.org plugin directory for
  discovery (free, ~2-week review). Stays on wordpress.org SVN
  repo; auto-updates via the WP admin notifier.
- **Phase 3**: list on woocommerce.com marketplace (paid listing,
  revenue share). Useful for merchant-acquisition; not required for
  function.

## 5. Async confirmation handling

Both platforms model "buyer paid but settlement pending" as a
**first-class state** — neither requires us to invent anything.

| Concept | Shopify | WooCommerce |
|---|---|---|
| Initial state after checkout | `financial_status=pending` (manual method) or `paymentSessionPending` (alt extension) | Order status `on-hold` |
| Settlement confirmation | `orderMarkAsPaid` / `paymentSessionResolve` | `$order->payment_complete($txn_id)` → moves to `processing` or `completed` |
| Buyer-facing message | Order-confirmation page text + email | Thank-you page hook + WC email template |
| Existing precedent | "Money Order", "Cash on Delivery" manual methods; Klarna's `pending` session | BACS, Cheque, COD plugins (all bundled) |
| Timeout / expiry | No platform-level. Merchant manually cancels stale orders. | `woocommerce_hold_stock_minutes` setting (default 60 min) — auto-cancels unpaid `on-hold` orders. **Disable for MPT** because SEPA can take a business day. |

### 5.1 Webhook signing (gateway → merchant)

Both platforms expect/use HMAC-SHA256 over the raw request body with
a shared secret. Concrete patterns to mirror:

- **Shopify outbound (us → Shopify)**: standard `Authorization: Bearer
  <access_token>` for Admin GraphQL.
- **Shopify inbound (Shopify → us, e.g. `orders/create`)**: verify
  base64 HMAC-SHA256 of raw body in `X-Shopify-Hmac-SHA256` header
  against the app's shared secret. **Must read raw body before any
  body parser.**
- **MPT → merchant callback** (both platforms): we emit
  `X-MPT-Signature: <hex_hmac_sha256(body, shared_secret)>` plus an
  `X-MPT-Timestamp` header to defend against replay. Constant-time
  compare on the merchant side (`hash_equals` in PHP).

### 5.2 Refunds

- **WooCommerce**: implement `process_refund( $order_id, $amount, $reason )`
  in the gateway class. Returns `true` on success, `WP_Error` on
  failure. Triggers from the order admin page. MPT can call the
  merchant's Safe via a "refund" Role (out of scope for v1; merchants
  refund manually from Safe Mobile).
- **Shopify** (manual method tier): refunds tracked in Shopify as
  separate operation; we'd POST `refundCreate` mutation if we want to
  reflect a manual refund. Not required for MVP.

For MVP both platforms can advertise: "refunds are issued out-of-band
by the merchant directly from their Safe." Aligns with the
per-event-Safe vision's custody model.

## 6. MVP plan — shortest path to "first merchant accepts MPT"

### 6.1 WooCommerce (target: crobuy.hr)

**Engineering hours: ~30 h** over 1 sprint.

1. **6 h** — scaffold `mpt-for-woocommerce` plugin: classic gateway
   class, BACS-pattern instructions, admin settings (Safe address,
   shared secret, API base URL).
2. **6 h** — render EPC QR on thank-you page using existing
   pay.domovina.ai QR endpoint (`GET /api/qr/epc?safe=...&sid=...&amount=...`).
3. **4 h** — `woocommerce_api_mpt_gateway` callback handler, HMAC
   verification, idempotency (check `_order_paid_via_mpt_txhash`
   order meta before re-marking).
4. **4 h** — WooCommerce Blocks support shim
   (`AbstractPaymentMethodType` + minimal JS bundle).
5. **4 h** — manual smoke test on a sandbox WP/Woo install + on
   crobuy.hr's staging if available.
6. **6 h** — onboarding doc for merchants: install ZIP, paste Safe
   address, paste shared secret, test order. Croatian translation of
   user-facing strings.

Deliverable: one ZIP, reusable across all WooCommerce merchants.
Crobuy is our first install.

### 6.2 Shopify (target: croatisimo.hr)

**Engineering hours: ~20 h** + ~2 h per merchant onboarding.

1. **4 h** — Shopify Custom App scaffold (private app, no App Store):
   request `read_orders`, `write_orders` scopes; subscribe to
   `orders/create` webhook.
2. **4 h** — webhook handler: HMAC-verify, persist
   `{shopify_order_id, total, currency, customer_email}` → trigger
   MPT to render an EPC QR addressable at
   `pay.domovina.ai/c/<shopify_order_id>`.
3. **4 h** — manual-payment-method instructions template that
   directs buyer to `pay.domovina.ai/c/<order_id>` after checkout
   (Shopify supports liquid variables in the manual-method
   instructions or order-status page).
4. **4 h** — MPT confirmation → `orderMarkAsPaid` mutation; record
   tx_hash as an order metafield.
5. **4 h** — merchant onboarding doc: how to install the custom
   app, where to paste the shared secret, how to enable the manual
   payment method.

Deliverable: per-merchant ~2 h install ceremony, mostly clicks. No
Shopify Partner approval required, no App Store wait.

### 6.3 Cross-cutting

- Reuse the same MPT outbound callback contract for both — single
  webhook emitter on the MPT backend with platform routing on the
  inbound side (Shopify hits `orderMarkAsPaid`; WooCommerce hits
  `wc-api/mpt_gateway`).
- HMAC shared-secret per merchant (already planned in
  `mpt_merchant_callbacks` D1 table — see per-event-Safe rail doc).
- Croatian-language user-facing copy from day 1 (both target shops
  are HR-locale).

**Total MVP engineering: ~50 h ≈ 1.5 weeks of one engineer's
focused time** for both platforms, both target merchants live.

## 7. Verification of the two cited shops

### 7.1 croatisimo.hr — confirmed **Shopify**

Diagnostic evidence from `GET https://www.croatisimo.hr/products/led-svjetleca-lopta`:

- HTTP response header: `powered-by: Shopify`
- HTTP response header: `shopify-complexity-score: 2050`,
  `shopify-complexity-score-v2: 205`
- `Set-Cookie: _shopify_essential=...`
- Asset CDN: `https://cdn.shopify.com`,
  `https://www.croatisimo.hr/cdn/shop/files/...`
- Inline JS: `Shopify.shop = "fdeaa8-46.myshopify.com"` (the
  underlying myshopify subdomain), `Shopify.theme = {name:"Sense",
  theme_store_id:1356}`, locale `hr`, currency `EUR`, country `HR`
- Theme: Shopify "Sense" theme v14.0.0
- `<meta id="shopify-digital-wallet">` present

Verdict: standard Shopify storefront on a custom domain. Croatian
locale + EUR currency confirmed. Plan: Shopify Tier-1 (manual method)
path applies.

### 7.2 crobuy.hr — confirmed **WooCommerce on WordPress**

Diagnostic evidence from `GET https://www.crobuy.hr/proizvod/hrvatski-grb-veliki-zidni/`:

- Server: `LiteSpeed` (LiteSpeed-cached WordPress hosting, common in
  EU shared hosts)
- `link: <https://www.crobuy.hr/wp-json/>; rel="https://api.w.org/"`
  (WordPress REST API discoverable)
- `link: <.../wp-json/wp/v2/product/8277>; rel="alternate"; ...`
  (Woo product CPT exposed)
- CSS handles: `woocommerce-inline-inline-css`,
  `wd-woocommerce-base-css`, `wd-woo-single-prod-el-base-css`,
  `wd-woo-mod-stock-status-css`
- Plugins detected: `woocommerce-simple-auctions-master/`,
  `flexible-shipping/`, `js_composer/`
- Theme: **Woodmart** (`wp-content/themes/woodmart/`) + child theme
  `woodmart-child/` — Woodmart is a WooCommerce-specific theme.
- `Set-Cookie: mailchimp_landing_site=...`

Verdict: standard WooCommerce 8.x on WordPress 6.8.5 with Woodmart
theme. Plan: ship the WC plugin described in §4 and §6.1.

## 8. Open questions

- **Shopify Partner programme regional access**: docs do not state
  whether Croatian-incorporated partners can sign the revenue-share
  agreement; verify directly with Shopify Partner Support before
  committing to Tier-2.
- **Shopify checkout-UI extension** (separate from payments
  extension) — can it render a QR + IBAN block during checkout
  *without* the full payments-platform approval? Worth a 1-hour
  spike; would meaningfully improve Tier-1 UX.
- **WooCommerce Blocks "checkout-block payment-method content" React
  rendering of a QR**: confirmed supported via `registerPaymentMethod`
  `content` prop, but the QR generator needs to run client-side or
  embed an `<img>` from MPT's QR endpoint. Decide which.
- **Order-cancellation semantics**: how long does MPT keep a `sid`
  valid before considering it expired? Both Shopify and WooCommerce
  expect either eventual settlement or a webhook cancellation.
- **SCA / PSD2**: bank transfers are out of PSD2 SCA scope for the
  buyer's bank flow, but the EPC QR + Revolut flow may involve SCA at
  the bank. Confirm there's no merchant-side obligation.
- **PCI scope**: MPT touches no card data; both gateways above are
  PCI-out-of-scope. Document explicitly in the merchant onboarding
  doc.
- **MiCA / Hanfa posture for MPT-as-WC-gateway**: same open legal
  question as per-event-Safe rail; defer to counsel.
- **Refund flow on WooCommerce**: do we implement `process_refund`
  for v1, or document refund-from-Safe-Mobile as the merchant
  workflow? Leaning toward the latter to preserve custody story.

## 9. References

All URLs accessed 2026-05-21.

### Shopify

- Extensions for payments (overview):
  <https://shopify.dev/docs/apps/build/payments>
- Build an alternative payments extension:
  <https://shopify.dev/docs/apps/build/payments/alternative/build-an-alternative-payment-extension>
- Build an offsite payments extension with Shopify CLI:
  <https://shopify.dev/docs/apps/build/payments/offsite/use-the-cli>
- Payments app request reference:
  <https://shopify.dev/docs/apps/build/payments/request-reference>
- Payments processing model:
  <https://shopify.dev/docs/apps/build/payments/processing>
- Payments extension requirements (SLA, mTLS, pricing):
  <https://shopify.dev/docs/apps/build/payments/requirements>
- Payments extension review process:
  <https://shopify.dev/docs/apps/build/payments/payments-extension-review>
- Payments Apps API reference:
  <https://shopify.dev/docs/api/payments-apps>
- Webhook HTTPS delivery + HMAC:
  <https://shopify.dev/docs/apps/build/webhooks/subscribe/https>
- `orderMarkAsPaid` mutation:
  <https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderMarkAsPaid>
- `orderCreateManualPayment` mutation:
  <https://shopify.dev/docs/api/admin-graphql/latest/mutations/ordercreatemanualpayment>
- Manual payment methods (help):
  <https://help.shopify.com/en/manual/payments/manual-payments>
- Custom manual payment method (help):
  <https://help.shopify.com/en/manual/payments/manual-payments/custom-payment-method>
- Shopify Payments supported countries:
  <https://help.shopify.com/en/manual/payments/shopify-payments/supported-countries>

### WooCommerce

- Payment Gateway API:
  <https://developer.woocommerce.com/docs/features/payments/payment-gateway-api>
- Blocks payment-method integration:
  <https://developer.woocommerce.com/docs/block-development/extensible-blocks/cart-and-checkout-blocks/checkout-payment-methods/payment-method-integration/>
- WooCommerce Plugin API callbacks (`woocommerce_api_*`):
  <https://developer.woocommerce.com/docs/extensions/core-concepts/woocommerce-plugin-api-callback/>
- Working with webhooks:
  <https://developer.woocommerce.com/docs/best-practices/urls-and-routing/webhooks/>
- Bundled BACS gateway source:
  <https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/gateways/bacs/class-wc-gateway-bacs.php>
- Code reference — `AbstractPaymentMethodType`:
  <https://woocommerce.github.io/code-reference/files/woocommerce-src-blocks-payments-integrations-abstractpaymentmethodtype.html>
- Blocks payment-method docs on GitHub (canonical source):
  <https://github.com/woocommerce/woocommerce-blocks/blob/trunk/docs/third-party-developers/extensibility/checkout-payment-methods/payment-method-integration.md>

### Cited shops verification

- croatisimo.hr response inspected via `curl -sI` and grep for
  Shopify markers (see §7.1).
- crobuy.hr response inspected via `curl -sI` and grep for
  WooCommerce/WordPress markers (see §7.2).

### Internal

- [docs/product-vision/per-event-safe-rail.md](../product-vision/per-event-safe-rail.md)
  — the MPT architecture this gateway integrates with.
