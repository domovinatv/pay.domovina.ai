import type { BrandConfig } from '../_shared/types';

/**
 * Udruga e-Demokracija. Brand palette from the official brandbook
 * (e-Demokracija_Brandbook_2026.pdf, p.10): deep civic blue #2e5791 as
 * primary (CTAs, tricolor rim) and the signature fingerprint orange
 * #f7941d as accent. White ink on blue, black ink on the lighter orange
 * for AA contrast. Wordmark splits as hero "e-Demokracija" + tail "WALLET".
 *
 * First real (non-sample) tenant: members and supporters route donations
 * and membership dues through a self-custody EURe wallet on Gnosis. The
 * "1 EUR / 30 min dnevno" active-citizenship vision motivates a future
 * recurring-donation feature (tracked separately; not yet a flag here).
 */
export const brand: BrandConfig = {
  id: 'edemokracija',
  name: 'e-Demokracija Wallet',
  shortName: 'e-DEM',
  productSubtitle: 'Donacije za aktivno građanstvo',
  domain: 'edw.domovina.ai',
  pageTitle: 'e-Demokracija Wallet · Donacije za aktivno građanstvo',
  colors: {
    primary: '#2e5791', // brandbook plava
    primaryFg: '#FFFFFF',
    accent: '#f7941d', // brandbook narančasta (otisak prsta)
    accentFg: '#000000', // black ink on the lighter orange for AA contrast
  },
  copy: {
    welcomeTitle: 'e-Demokracija Wallet',
    welcomeSubtitle:
      'Podrži aktivno građanstvo — donacije i članarine za zajednicu, bez kartica i seed-a, samo Face ID i Keychain.',
    productName: 'e-Demokracija Wallet',
  },
  enabledFeatures: ['phone-binding', 'expand-access', 'activity-page'],
};
