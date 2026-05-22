import { create } from 'zustand';
import type { Address } from 'viem';

type WalletState = {
  credentialId: string | null;
  signerAddress: Address | null;
  safeAddress: Address | null;
  balance: string | null;
  setIdentity: (id: { credentialId: string; signerAddress: Address; safeAddress: Address }) => void;
  setBalance: (b: string) => void;
  reset: () => void;
};

export const useWalletStore = create<WalletState>((set) => ({
  credentialId: null,
  signerAddress: null,
  safeAddress: null,
  balance: null,
  setIdentity: ({ credentialId, signerAddress, safeAddress }) =>
    set({ credentialId, signerAddress, safeAddress }),
  setBalance: (balance) => set({ balance }),
  reset: () => set({ credentialId: null, signerAddress: null, safeAddress: null, balance: null }),
}));
