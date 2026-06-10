import { create } from 'zustand';
import type { Address } from 'viem';
import type { WalletAccount } from '../lib/accounts';
import { isSimpleMode, setSimpleModeFor } from '../lib/simpleMode';

type WalletState = {
  credentialId: string | null;
  signerAddress: Address | null;
  safeAddress: Address | null;
  balance: string | null;
  /** ADR 0013 account context for the ACTIVE account. */
  saltNonce: string | null;
  recoveryOwner: Address | null;
  accountKind: 'bootstrap' | 'derived' | null;
  accountName: string | null;
  /** Per-account display preference (lib/simpleMode): everyday-wallet UI. */
  simpleMode: boolean;
  /** Set the active identity at its bootstrap account (hot-path send, no
   * saltNonce/recoveryOwner). Used by the identity-level entry flows. */
  setIdentity: (id: { credentialId: string; signerAddress: Address; safeAddress: Address }) => void;
  /** Set the active account from a full WalletAccount (bootstrap OR derived),
   * carrying the saltNonce + recoveryOwner that the relay cold path needs. */
  setAccount: (a: WalletAccount) => void;
  setBalance: (b: string) => void;
  /** Toggle the simple-view preference for the ACTIVE account (persisted). */
  setSimpleMode: (on: boolean) => void;
  reset: () => void;
};

const EMPTY = {
  credentialId: null,
  signerAddress: null,
  safeAddress: null,
  balance: null,
  saltNonce: null,
  recoveryOwner: null,
  accountKind: null,
  accountName: null,
  simpleMode: false,
} as const;

export const useWalletStore = create<WalletState>((set) => ({
  ...EMPTY,
  setIdentity: ({ credentialId, signerAddress, safeAddress }) =>
    set({
      credentialId,
      signerAddress,
      safeAddress,
      saltNonce: null,
      recoveryOwner: null,
      accountKind: 'bootstrap',
      accountName: null,
      simpleMode: isSimpleMode(safeAddress),
    }),
  setAccount: (a) =>
    set({
      credentialId: a.credentialId,
      signerAddress: a.signerAddress,
      safeAddress: a.safeAddress,
      saltNonce: a.saltNonce ?? null,
      recoveryOwner: a.recoveryOwner ?? null,
      accountKind: a.kind,
      accountName: a.name,
      simpleMode: isSimpleMode(a.safeAddress),
      // New account selected — clear the stale balance so the home screen shows
      // a loading dash instead of the previous account's number until refetch.
      balance: null,
    }),
  setBalance: (balance) => set({ balance }),
  setSimpleMode: (on) =>
    set((s) => {
      if (s.safeAddress) setSimpleModeFor(s.safeAddress, on);
      return { simpleMode: on };
    }),
  reset: () => set({ ...EMPTY }),
}));
