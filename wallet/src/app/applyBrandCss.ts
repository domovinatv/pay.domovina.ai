import { brand } from './brand';

/**
 * Push the active brand's colors onto `:root` as CSS variables so the
 * Tailwind `brand-primary` / `brand-accent` color tokens resolve per
 * tenant. Variables hold the RGB triplet (space-separated, no rgb()
 * wrapper) so Tailwind's `<alpha-value>` syntax keeps working —
 * matches the convention already used for `--surface-*` and `--ink-*`
 * in `styles/index.css`.
 *
 * Also sets `document.title` to the brand's pageTitle so each tenant
 * gets the right title in browser tabs, share previews that read
 * <title>, and the iOS Safari "Add to Home Screen" default name.
 *
 * Call this BEFORE the React render in `main.tsx` so the very first
 * paint already uses the correct palette.
 */
export function applyBrandCss(): void {
  const root = document.documentElement;
  root.style.setProperty('--brand-primary', hexToRgbTriplet(brand.colors.primary));
  root.style.setProperty('--brand-primary-fg', hexToRgbTriplet(brand.colors.primaryFg));
  root.style.setProperty('--brand-accent', hexToRgbTriplet(brand.colors.accent));
  root.style.setProperty('--brand-accent-fg', hexToRgbTriplet(brand.colors.accentFg));
  document.title = brand.pageTitle;
  // data-brand attribute on <html> lets stylesheets opt into per-brand
  // overrides without re-importing the brand module (rare; useful for
  // hacks like inverting on dark logos).
  root.setAttribute('data-brand', brand.id);
}

function hexToRgbTriplet(hex: string): string {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) {
    console.warn(`[applyBrandCss] expected 6-char hex, got "${hex}"`);
    return '0 0 0';
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}
