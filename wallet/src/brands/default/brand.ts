import type { BrandConfig } from '../_shared/types';

/**
 * Default DOMOVINA Wallet brand — the original tenant, kept identical to
 * what shipped before the brand-as-data refactor. Croatian navy + red
 * palette mirrors donate.domovina.ai and the broader DOMOVINA brand
 * (see memory [[reference-domovina-brand]]).
 */
export const brand: BrandConfig = {
  id: 'default',
  name: 'DOMOVINA Wallet',
  shortName: 'DOMOVINA',
  productSubtitle: 'Self-custody EURe wallet',
  domain: 'wallet.domovina.ai',
  pageTitle: 'DOMOVINA Wallet · Self-custody EURe na Gnosisu',
  colors: {
    primary: '#002F6C', // navy
    primaryFg: '#FFFFFF',
    accent: '#FF0000', // Croatian red
    accentFg: '#FFFFFF',
  },
  copy: {
    welcomeTitle: 'Self-custody EURe wallet',
    welcomeSubtitle: 'Bez seed phrase-a. Bez password-a. Samo Face ID i Keychain.',
    productName: 'DOMOVINA Wallet',
  },
  enabledFeatures: ['phone-binding', 'expand-access', 'activity-page'],
};
