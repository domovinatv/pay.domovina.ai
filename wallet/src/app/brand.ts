import type { BrandConfig } from '../brands/_shared/types';
import { brand as defaultBrand } from '../brands/default/brand';
import { brand as sportklubBrand } from '../brands/sportklub/brand';
import { brand as zupaBrand } from '../brands/zupa/brand';
import { brand as edemokracijaBrand } from '../brands/edemokracija/brand';

/**
 * Brand registry. All known tenants are imported eagerly here — each
 * config is a few hundred bytes of plain data so the tree-shaking
 * overhead of importing all three is negligible. When a 10th tenant
 * lands we will revisit with dynamic imports or build-time aliasing.
 *
 * The active brand is selected by `VITE_BRAND` at build time. CI passes
 * the env per matrix step; local `npm run build` defaults to `default`
 * and the same dist deploys to `wallet-domovina` CF Pages project.
 */
const REGISTRY: Record<string, BrandConfig> = {
  default: defaultBrand,
  sportklub: sportklubBrand,
  zupa: zupaBrand,
  edemokracija: edemokracijaBrand,
};

function resolveActiveBrand(): BrandConfig {
  const id = (import.meta.env.VITE_BRAND as string | undefined)?.trim() || 'default';
  const found = REGISTRY[id];
  if (!found) {
    console.warn(`[brand] unknown VITE_BRAND="${id}", falling back to "default"`);
    return defaultBrand;
  }
  return found;
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
