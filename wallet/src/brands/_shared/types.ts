/**
 * Brand-as-data: every tenant of the wallet shell is described by one of
 * these configs. Selected at build time via VITE_BRAND env (see
 * `app/brand.ts`). The shape is intentionally flat — no nested optional
 * sub-objects — so adding a fourth or fifth tenant is a copy-paste of an
 * existing brand file plus a registration line in `app/brand.ts`.
 *
 * What goes here: anything a partner would want to customize without
 * touching `core/` code (colors, copy, page title, feature toggles).
 *
 * What does NOT go here: business logic, routes, components. Tenant-only
 * components live in `brands/<id>/custom/` and are mounted via
 * `enabledFeatures` flags inside `core/` rendering paths.
 */
export type BrandConfig = {
  /** Stable identifier — also the directory name under `brands/` and the
   * value passed via `VITE_BRAND` env at build time. */
  id: string;

  /** Full product name shown in the brand header, page title, and as the
   * default prefix for passkey labels in the OS Keychain. */
  name: string;

  /** Short identifier for tight UI slots (≤12 chars). Currently unused
   * but reserved for future bottom-tab labels and PWA manifests. */
  shortName: string;

  /** Tagline rendered under the wordmark on Landing. */
  productSubtitle: string;

  /** Canonical hostname this brand will live at. Drives the share URL
   * fallback when the deep link is not useful (see Receive share). */
  domain: string;

  /** Verbatim string set on `document.title` at app boot. */
  pageTitle: string;

  /** Primary + accent color pair. Used by CSS variable mapping in
   * `applyBrandCss` so Tailwind utilities `bg-brand-primary` etc. resolve
   * per-tenant. Hex strings; foreground vars are used for text/icons
   * placed on top of the corresponding background color. */
  colors: {
    primary: string;
    primaryFg: string;
    accent: string;
    accentFg: string;
  };

  /** Strings that vary across brands. Keep this list small — add an entry
   * only when a real tenant would want a different value. Anything generic
   * stays hardcoded in `core/`. */
  copy: {
    /** Headline on the Landing welcome view (when no local wallets). */
    welcomeTitle: string;
    /** Subtitle paragraph immediately below welcomeTitle. */
    welcomeSubtitle: string;
    /** Prefix written into OS Keychain at passkey enrollment time, e.g.
     * `"DOMOVINA Wallet"` → final entry `"DOMOVINA Wallet · Glavni"`. */
    productName: string;
  };

  /** Feature flag list. Components in `core/` may render conditionally on
   * these. Tenant-only routes are loaded from `brands/<id>/custom/` and
   * registered via this list (future iteration). */
  enabledFeatures: string[];
};
