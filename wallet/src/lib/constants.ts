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

// Monerium EURe **V2** on Gnosis (the proxy that emits Transfer events + that the
// rail/indexer use). V1 (0xcB444e90 "EUR emoney") is legacy: same balance but its
// events fire separately, so a V1-pinned wallet missed post-cutover activity and
// couldn't scan V2 payment QRs. Gnosis is long past the V1→V2 cutover (block
// 35656951). See docs/reference/monerium-contracts.md.
export const EURE_ADDRESS = '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430' as const;
export const EURE_DECIMALS = 18;

export const SAFE_WEBAUTHN_SIGNER_FACTORY = '0x1d31F259eE307358a26dFb23EB365939E8641195' as const;
export const SAFE_WEBAUTHN_SHARED_SIGNER = '0x94a4F6affBd8975951142c3999aEAB7ecee555c2' as const;
export const DAIMO_P256_VERIFIER = '0xc2b78104907F722DABAc4C69f826a522B2754De4' as const;
export const P256_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000100' as const;

// Parent-domain RP ID so the same passkey can be surfaced to any
// *.domovina.ai page natively. Without this, a passkey bound to
// wallet.domovina.ai is invisible to e.g. donate.domovina.ai. See
// docs/plans/cross-domain-wallet-passkey.md Phase B.
function deriveRpId(): string {
  if (typeof window === 'undefined') return 'wallet.domovina.ai';
  const host = window.location.hostname;
  if (host === 'domovina.ai' || host.endsWith('.domovina.ai')) return 'domovina.ai';
  return host;
}

export const RP_ID = deriveRpId();
export const RP_NAME = 'DOMOVINA Wallet';

// Backend Worker lives at mpt.domovina.ai (and monerium.domovina.ai — same Worker,
// dual hostname). NOT pay.domovina.ai — that's the Flutter app frontend.
export const PAYMENT_INTENT_API_BASE = import.meta.env.VITE_PAYMENT_INTENT_API_BASE ?? 'https://mpt.domovina.ai';

export const RELAY_FREE_DAILY_LIMIT = 5;
