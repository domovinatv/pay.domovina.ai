import type { BrandConfig } from '../brands/_shared/types';
import { brand as defaultBrand } from '../brands/default/brand';
import { brand as sportklubBrand } from '../brands/sportklub/brand';
import { brand as zupaBrand } from '../brands/zupa/brand';
import { brand as edemokracijaBrand } from '../brands/edemokracija/brand';

/**
 * Brand registry. All known tenants are imported eagerly here — each
 * config is a few hundred bytes of plain data so the tree-shaking
 * overhead of importing all of them is negligible. When the tenant count
 * grows large we will revisit with dynamic imports or build-time aliasing.
 */
const REGISTRY: Record<string, BrandConfig> = {
  default: defaultBrand,
  sportklub: sportklubBrand,
  zupa: zupaBrand,
  edemokracija: edemokracijaBrand,
};

/**
 * Active-brand resolution (ADR 0015 — runtime multi-tenant). Priority:
 *
 *   1. `VITE_BRAND` build-time env — explicit override for a dedicated
 *      per-brand deployment (kept for back-compat / isolated builds).
 *   2. `location.hostname` match against each brand's `domain` — this is
 *      the multi-tenant path: ONE deployment (wallet-domovina) serves
 *      every brand, selected by the hostname the user loaded. The shared
 *      same-origin relayer Functions (`/api/relay`) and the shared intents
 *      API (`mpt.domovina.ai`) are reused verbatim — no per-brand backend.
 *   3. `default`.
 *
 * Build-time bits that can only bake ONE brand per deployment (index.html
 * <title>/theme-color, the PWA manifest in vite.config) stay on the build
 * brand; the in-app experience (CSS vars, document.title, copy) is
 * corrected at first paint by `applyBrandCss` reading this resolved brand.
 * A per-hostname dynamic manifest is a tracked follow-up.
 */
function resolveActiveBrand(): BrandConfig {
  const envId = (import.meta.env.VITE_BRAND as string | undefined)?.trim();
  if (envId) {
    const found = REGISTRY[envId];
    if (found) return found;
    console.warn(`[brand] unknown VITE_BRAND="${envId}", falling back to hostname/default`);
  }

  if (typeof window !== 'undefined' && window.location?.hostname) {
    const host = window.location.hostname.toLowerCase();
    const byHost = Object.values(REGISTRY).find((b) => b.domain.toLowerCase() === host);
    if (byHost) return byHost;
  }

  return defaultBrand;
}

export const brand: BrandConfig = resolveActiveBrand();

/** Helper for `enabledFeatures` checks scattered across core. Keeps the
 * call site short and gives us one place to add caching/instrumentation
 * if any feature flag ever becomes hot enough to matter. */
export function isFeatureEnabled(featureId: string): boolean {
  return brand.enabledFeatures.includes(featureId);
}

/** Every sibling brand the user could plausibly authorize a link from,
 * minus the active brand itself (linking with yourself is a no-op).
 *
 * All brand configs are imported eagerly above, so this list is bundled
 * into every brand build — sportklub knows about default + zupa, default
 * knows about sportklub + zupa, etc. That is what enables the N-to-N
 * linking UI: peers list each other, not just "master + tenants".
 */
export function getLinkTargets(): BrandConfig[] {
  return Object.values(REGISTRY).filter((b) => b.id !== brand.id);
}
