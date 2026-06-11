/**
 * Gnosis Pay onboarding stanje — zaseban store od useWalletStore jer je GP
 * kontekst vezan uz GP JWT sesiju (u memoriji), ne uz lokalni wallet identitet.
 *
 * Router "sljedećeg koraka" (GpStep) je ČISTA derivacija iz GET /api/v1/user
 * + JWT decode + /user/terms — nikakvo lokalno pamćenje napretka (02-onboarding.md).
 */
import { create } from 'zustand';
import {
  decodeGpJwt,
  getGpJwt,
  gpApi,
  GpAuthExpiredError,
  type GpTerm,
  type GpUser,
} from '../lib/gnosispay';

export type GpStep =
  | 'anon' //          nema (važećeg) JWT-a → SIWE login
  | 'signup' //        JWT bez userId → email (+OTP) signup
  | 'terms' //         neprihvaćeni ToS-ovi
  | 'kyc' //           kycStatus notStarted/documentsRequested → Sumsub iframe
  | 'kyc-pending' //   pending/processing → polling
  | 'kyc-action' //    resubmissionRequested/requiresAction → support poruka
  | 'kyc-rejected' //  TRAJNO odbijen, bez retryja
  | 'sof' //           source-of-funds upitnik
  | 'phone' //         telefon OTP (gated iza KYC approved)
  | 'deploy' //        safeWallets prazan → POST /safe/deploy
  | 'ready'; //        GP Safe postoji → kartice (Faza 2)

export function deriveGpStep(user: GpUser | null, terms: GpTerm[] | null): GpStep {
  const jwt = decodeGpJwt();
  if (!getGpJwt() || !jwt) return 'anon';
  if (!jwt.userId) return 'signup';
  if (!user) return 'anon'; // userId postoji a /user nije dohvaćen → refresh pa ponovo
  if (terms && terms.some((t) => !t.accepted)) return 'terms';
  switch (user.kycStatus) {
    case 'notStarted':
    case 'documentsRequested':
      return 'kyc';
    case 'pending':
    case 'processing':
      return 'kyc-pending';
    case 'resubmissionRequested':
    case 'requiresAction':
      return 'kyc-action';
    case 'rejected':
      return 'kyc-rejected';
    case 'approved':
      break;
  }
  if (!user.isSourceOfFundsAnswered) return 'sof';
  if (!user.isPhoneValidated) return 'phone';
  if (user.safeWallets.length === 0) return 'deploy';
  return 'ready';
}

type GpState = {
  user: GpUser | null;
  terms: GpTerm[] | null;
  step: GpStep;
  refreshing: boolean;
  /** Povuci /user (+ /user/terms dok ToS-ovi nisu svi prihvaćeni) i izračunaj korak.
   * Na istek JWT-a tiho pada u 'anon' — UI nudi novu passkey prijavu. */
  refresh: () => Promise<GpStep>;
  /** Nakon logina/signupa: postavi stanje bez čekanja refresh-a. */
  bump: () => void;
  reset: () => void;
};

export const useGpStore = create<GpState>((set, get) => ({
  user: null,
  terms: null,
  step: 'anon',
  refreshing: false,

  refresh: async () => {
    const jwt = decodeGpJwt();
    if (!jwt) {
      set({ user: null, terms: null, step: 'anon' });
      return 'anon';
    }
    if (!jwt.userId) {
      // /user bi vratio 401 (nije signup-an) i lažno "istekao" sesiju — preskoči.
      set({ user: null, terms: null, step: 'signup' });
      return 'signup';
    }
    set({ refreshing: true });
    try {
      const user = await gpApi.user();
      // Terms dohvaćamo samo dok nisu svi prihvaćeni (nakon toga je polje stabilno).
      const prevTerms = get().terms;
      const allAccepted = prevTerms?.every((t) => t.accepted) ?? false;
      const terms = allAccepted ? prevTerms : (await gpApi.userTerms()).terms;
      const step = deriveGpStep(user, terms);
      set({ user, terms, step, refreshing: false });
      return step;
    } catch (e) {
      set({ refreshing: false });
      if (e instanceof GpAuthExpiredError) {
        set({ user: null, terms: null, step: 'anon' });
        return 'anon';
      }
      throw e;
    }
  },

  bump: () => set({ step: deriveGpStep(get().user, get().terms) }),

  reset: () => set({ user: null, terms: null, step: 'anon', refreshing: false }),
}));
