import type { BrandConfig } from '../_shared/types';

/**
 * Sample tenant: a hypothetical sports-club wallet. Blue/white palette in
 * the SofaScore family — deep blue primary, white accent for the rim and
 * surfaces. Used to validate that the brand-as-data plumbing actually
 * yields a visually distinct app from the default DOMOVINA build.
 */
export const brand: BrandConfig = {
  id: 'sportkluba',
  name: 'SK Wallet',
  shortName: 'SportKluba',
  productSubtitle: 'EURe za navijače i sponzore',
  domain: 'sportkluba.domovina.ai',
  pageTitle: 'SK Wallet · EURe za navijače',
  colors: {
    primary: '#1A4B8A', // SofaScore-style deep blue
    primaryFg: '#FFFFFF',
    accent: '#FFFFFF', // white rim
    accentFg: '#1A4B8A',
  },
  copy: {
    welcomeTitle: 'SK Wallet',
    welcomeSubtitle: 'Self-custody EURe za navijače i sponzore — bez seed phrase-a, samo Face ID i Keychain.',
    productName: 'SK Wallet',
  },
  enabledFeatures: ['phone-binding', 'expand-access', 'activity-page'],
};
