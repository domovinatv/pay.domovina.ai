import type { BrandConfig } from '../_shared/types';

/**
 * Sample tenant: a hypothetical parish (mjesna župa) wallet. Vatican
 * flag palette — white surface with gold/yellow primary for CTAs and
 * brand accents. Used to validate that the brand-as-data plumbing
 * generalizes to high-contrast non-blue palettes.
 */
export const brand: BrandConfig = {
  id: 'zupa',
  name: 'Župa Wallet',
  shortName: 'Župa',
  productSubtitle: 'Digitalna lepta',
  domain: 'zupa.domovina.ai',
  pageTitle: 'Župa Wallet · Digitalna lepta',
  colors: {
    primary: '#FFCC00', // Vatican gold
    primaryFg: '#000000', // black ink on gold for AA contrast
    accent: '#FFFFFF',
    accentFg: '#000000',
  },
  copy: {
    welcomeTitle: 'Župa Wallet',
    welcomeSubtitle: 'Digitalna lepta i milodari za župnu zajednicu — Face ID, bez kartica.',
    productName: 'Župa Wallet',
  },
  enabledFeatures: ['phone-binding', 'expand-access', 'activity-page'],
};
