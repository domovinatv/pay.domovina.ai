import { brand } from '../app/brand';

/**
 * Brand wordmark + accent stripe shown on every Landing screen. Reads
 * from the active BrandConfig so tenant builds render their own colors
 * + name without any per-component overrides.
 *
 * The bar under the wordmark is the brand identity stripe: primary on
 * the left, surface in the middle, accent on the right. For the default
 * DOMOVINA brand that reads as navy / white / red (the Croatian flag);
 * for sportkluba blue / white / white; for zupa gold / white / white.
 */
export function BrandHeader() {
  // Split the brand name into a hero word + tail so layouts that want a
  // big display word + small uppercase suffix still get one. "DOMOVINA
  // Wallet" → "DOMOVINA" + "Wallet"; "SK Wallet" → "SK" + "Wallet";
  // "Župa Wallet" → "Župa" + "Wallet". Single-word brand names render
  // the whole string as the hero with no suffix.
  const trimmed = brand.name.trim();
  const firstSpace = trimmed.indexOf(' ');
  const hero = firstSpace > 0 ? trimmed.slice(0, firstSpace) : trimmed;
  const tail = firstSpace > 0 ? trimmed.slice(firstSpace + 1) : '';

  return (
    <header className="flex flex-col items-center gap-2 pt-12 pb-8">
      <div className="flex h-1 w-32 overflow-hidden rounded-pill">
        <div className="flex-1 bg-brand-accent" />
        <div className="flex-1 bg-surface-raised border-y border-surface-border" />
        <div className="flex-1 bg-brand-primary" />
      </div>
      <h1 className="text-3xl font-bold tracking-tight text-ink-primary">{hero}</h1>
      {tail && <p className="text-sm text-ink-muted uppercase tracking-widest">{tail}</p>}
    </header>
  );
}
