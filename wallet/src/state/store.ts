import { create } from 'zustand';
import type { Address } from 'viem';

type Screen = 'wallet' | 'receive' | 'send' | 'bind-phone';

type WalletState = {
  screen: Screen;
  credentialId: string | null;
  signerAddress: Address | null;
  safeAddress: Address | null;
  balance: string | null;
  setScreen: (s: Screen) => void;
  setIdentity: (id: { credentialId: string; signerAddress: Address; safeAddress: Address }) => void;
  setBalance: (b: string) => void;
  reset: () => void;
};

export const useWalletStore = create<WalletState>((set) => ({
  screen: 'wallet',
  credentialId: null,
  signerAddress: null,
  safeAddress: null,
  balance: null,
  setScreen: (screen) => set({ screen }),
  setIdentity: ({ credentialId, signerAddress, safeAddress }) =>
    set({ credentialId, signerAddress, safeAddress }),
  setBalance: (balance) => set({ balance }),
  reset: () => set({ credentialId: null, signerAddress: null, safeAddress: null, balance: null, screen: 'wallet' }),
}));
