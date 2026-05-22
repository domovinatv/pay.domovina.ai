import { defineChain } from 'viem';

export const GNOSIS_CHAIN_ID = 100;

export const gnosis = defineChain({
  id: GNOSIS_CHAIN_ID,
  name: 'Gnosis',
  nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.gnosischain.com'] },
  },
  blockExplorers: {
    default: { name: 'Gnosisscan', url: 'https://gnosisscan.io' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
});

export const EURE_ADDRESS = '0xcB444e90D8198415266c6a2724b7900fb12FC56E' as const;
export const EURE_DECIMALS = 18;

export const SAFE_WEBAUTHN_SIGNER_FACTORY = '0x1d31F259eE307358a26dFb23EB365939E8641195' as const;
export const SAFE_WEBAUTHN_SHARED_SIGNER = '0x94a4F6affBd8975951142c3999aEAB7ecee555c2' as const;
export const DAIMO_P256_VERIFIER = '0xc2b78104907F722DABAc4C69f826a522B2754De4' as const;
export const P256_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000100' as const;

export const RP_ID = (typeof window !== 'undefined' && window.location.hostname) || 'wallet.domovina.ai';
export const RP_NAME = 'DOMOVINA Wallet';

// Backend Worker lives at mpt.domovina.ai (and monerium.domovina.ai — same Worker,
// dual hostname). NOT pay.domovina.ai — that's the Flutter app frontend.
export const PAYMENT_INTENT_API_BASE = import.meta.env.VITE_PAYMENT_INTENT_API_BASE ?? 'https://mpt.domovina.ai';

export const RELAY_FREE_DAILY_LIMIT = 5;
