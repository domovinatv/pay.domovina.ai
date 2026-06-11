/**
 * Gnosis Pay API klijent — Faza 1 (onboarding domena, 02-onboarding.md).
 *
 * Plan A (findings-faza0.md): GP identitet korisnika = njegov DOMOVINA Safe,
 * SIWE potpisan kroz passkey kao Safe ERC-1271 contract signature. JWT živi
 * ISKLJUČIVO u memoriji (nikad localStorage — XSS scope); na 401 se baca
 * GpAuthExpiredError i UI vodi korisnika kroz novu passkey ceremoniju (iOS
 * ionako traži user gesture, tihi re-auth nije moguć).
 *
 * Empirijski WAF nalazi (Faza 0) ugrađeni ovdje:
 *  - SIWE poruka NE smije sadržavati loopback URL (WAF 403) → na localhostu
 *    se koristi GP-ova whitelistana SIWE helper domena umjesto localhost URI-ja.
 *  - Produkcijska domena radi tek nakon partner registracije
 *    ("SIWE domain not allowed") — TODO-MATIJA #1.
 */
import {
  encodeAbiParameters,
  hashMessage,
  hashTypedData,
  hexToBytes,
  type Address,
  type Hex,
} from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { GNOSIS_CHAIN_ID } from './constants';
import { getActivePasskey, recordRpId, signWithPasskey, type PasskeyRecord } from './passkey';
import { encodeWebAuthnSignature } from './safe';

const GP_API = 'https://api.gnosispay.com';

/** GP-ova vlastita SIWE helper aplikacija (linkana iz docs) — jedina domena koja
 * prolazi i WAF i app-level whitelist u developmentu. */
const DEV_SIWE_DOMAIN = 'gnosispay-api-siwe-demo.vercel.app';

// ── JWT u memoriji ────────────────────────────────────────────────────────────

let jwt: string | null = null;

export function getGpJwt(): string | null {
  return jwt;
}

export function clearGpJwt(): void {
  jwt = null;
}

export type GpJwtPayload = {
  signerAddress: Address;
  chainId: number;
  userId?: string;
  hasSignedUp?: boolean;
  partnerId: string | null;
  exp: number;
};

export function decodeGpJwt(token = jwt): GpJwtPayload | null {
  if (!token) return null;
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/** Istekao ili nepostojeći JWT — UI mora ponoviti SIWE (passkey ceremonija). */
export class GpAuthExpiredError extends Error {
  constructor() {
    super('Gnosis Pay prijava je istekla');
    this.name = 'GpAuthExpiredError';
  }
}

export class GpApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message?: string,
  ) {
    super(message ?? `Gnosis Pay API ${status}`);
    this.name = 'GpApiError';
  }
}

function bodyError(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'string') return b.error;
    if (typeof b.message === 'string') return b.message;
  }
  return undefined;
}

async function gpFetch<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.auth !== false) {
    if (!jwt) throw new GpAuthExpiredError();
    headers.Authorization = `Bearer ${jwt}`;
  }
  const res = await fetch(`${GP_API}${path}`, { ...init, headers });
  if (res.status === 401) {
    jwt = null;
    throw new GpAuthExpiredError();
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new GpApiError(res.status, body, bodyError(body));
  return body as T;
}

// ── SIWE login (Plan A: Safe ERC-1271 preko passkeya) ─────────────────────────

function siweDomain(): { domain: string; uri: string } {
  const h = window.location.hostname;
  if (h === 'localhost' || h === '127.0.0.1') {
    return { domain: DEV_SIWE_DOMAIN, uri: `https://${DEV_SIWE_DOMAIN}` };
  }
  return { domain: window.location.host, uri: window.location.origin };
}

/**
 * ERC-1271 potpis SIWE poruke: passkey potpisuje EIP-712 SafeMessage hash
 * (ista WebAuthn ceremonija kao Send, samo je challenge SafeMessage umjesto
 * SafeTx). encodeWebAuthnSignature vraća Safe contract-signature blob koji
 * GP-ov verifier validira pozivom isValidSignature na (deployani!) Safe.
 */
async function signSiweWithPasskey(
  passkey: PasskeyRecord,
  message: string,
): Promise<Hex> {
  const dataHash = hashMessage(message);
  const safeMessageHash = hashTypedData({
    domain: { chainId: GNOSIS_CHAIN_ID, verifyingContract: passkey.safeAddress },
    types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
    primaryType: 'SafeMessage',
    message: { message: encodeAbiParameters([{ type: 'bytes32' }], [dataHash]) },
  });
  const assertion = await signWithPasskey(
    passkey.credentialId,
    hexToBytes(safeMessageHash),
    recordRpId(passkey),
  );
  return encodeWebAuthnSignature({ ...assertion, signerAddress: passkey.signerAddress });
}

/**
 * Puni SIWE login: nonce → passkey ceremonija → JWT (24 h). Preduvjet Plana A:
 * Safe mora biti deployan (counterfactual nema koda → 1271 pada) — caller je
 * dužan to osigurati prije poziva ("Aktiviraj račun" flow).
 */
export async function gpLogin(): Promise<GpJwtPayload> {
  const passkey = getActivePasskey();
  if (!passkey) throw new Error('Nema aktivnog passkeya');
  const nonce = (await gpFetch<string>('/api/v1/auth/nonce', { auth: false })).trim();
  const { domain, uri } = siweDomain();
  const message = createSiweMessage({
    domain,
    address: passkey.safeAddress,
    uri,
    version: '1',
    chainId: GNOSIS_CHAIN_ID,
    nonce,
    issuedAt: new Date(),
  });
  const signature = await signSiweWithPasskey(passkey, message);
  const res = await gpFetch<{ token: string }>('/api/v1/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ message, signature, ttlInSeconds: 86400 }),
    auth: false,
  });
  jwt = res.token;
  const payload = decodeGpJwt();
  if (!payload) throw new Error('Neispravan GP JWT');
  return payload;
}

// ── Tipovi (GET /api/v1/user = izvor istine za state machine) ─────────────────

export type GpKycStatus =
  | 'notStarted'
  | 'documentsRequested'
  | 'pending'
  | 'processing'
  | 'approved'
  | 'resubmissionRequested'
  | 'rejected'
  | 'requiresAction';

export type GpUser = {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
  signInWallets: { address: Address }[];
  safeWallets: { address: Address; chainId?: number; tokenSymbol?: string }[];
  kycStatus: GpKycStatus;
  cards: unknown[];
  isSourceOfFundsAnswered: boolean;
  isPhoneValidated: boolean;
  partnerId: string | null;
  status: string;
};

export type GpTerm = {
  type: string;
  currentVersion: string;
  accepted?: boolean;
  acceptedVersion?: string | null;
  url: string;
  name?: string;
};

export type GpSofQuestion = { question: string; answers?: string[] };

export type GpDeployStatus = 'processing' | 'ok' | 'failed' | 'not_deployed';

export type GpSafeConfig = {
  address?: Address;
  tokenSymbol?: string;
  /** AccountIntegrityStatus enum; null prije deploya (empirijski) — uvijek null-guard. */
  accountStatus: number | null;
  accountAllowance?: string | null;
  hasNoApprovals?: boolean;
};

// ── Endpointi (samo onboarding domena iz 02-onboarding.md) ────────────────────

export const gpApi = {
  user: () => gpFetch<GpUser>('/api/v1/user'),

  signupOtp: (email: string) =>
    gpFetch<{ ok: boolean }>('/api/v1/auth/signup/otp', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  /** 409 = adresa ili email već vezani (nepovratno!). partnerId SAMO ovdje. */
  signup: async (authEmail: string, otp?: string) => {
    const partnerId = import.meta.env.VITE_GP_PARTNER_ID as string | undefined;
    const res = await gpFetch<{ id: string; token: string; hasSignedUp: boolean }>(
      '/api/v1/auth/signup',
      {
        method: 'POST',
        body: JSON.stringify({
          authEmail,
          ...(otp ? { otp } : {}),
          ...(partnerId ? { partnerId } : {}),
        }),
      },
    );
    jwt = res.token; // user-scoped JWT (⚠️ exp = 1 h, kraći od SIWE JWT-a)
    return res;
  },

  userTerms: () => gpFetch<{ terms: GpTerm[] }>('/api/v1/user/terms'),

  acceptTerms: (terms: string, version: string) =>
    gpFetch<{ ok: boolean }>('/api/v1/user/terms', {
      method: 'POST',
      body: JSON.stringify({ terms, version }),
    }),

  kycIntegration: (lang = 'hr') =>
    gpFetch<{ type: string; url: string }>(`/api/v1/kyc/integration?lang=${lang}`),

  sourceOfFundsQuestions: () => gpFetch<GpSofQuestion[]>('/api/v1/source-of-funds'),

  submitSourceOfFunds: (answers: { question: string; answer: string }[]) =>
    gpFetch<unknown>('/api/v1/source-of-funds', {
      method: 'POST',
      body: JSON.stringify(answers),
    }),

  /** Gated iza KYC approved; zamjenjuje postojeći broj; 429 = rate limit. */
  startPhoneVerification: (phoneNumber: string) =>
    gpFetch<unknown>('/api/v1/verification', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    }),

  checkPhoneVerification: (code: string) =>
    gpFetch<unknown>('/api/v1/verification/check', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  deploySafe: (dailyLimit?: number) =>
    gpFetch<{ status: string }>('/api/v1/safe/deploy', {
      method: 'POST',
      body: JSON.stringify(dailyLimit ? { dailyLimit } : {}),
    }),

  deployStatus: () =>
    gpFetch<{ status: GpDeployStatus; updatedAt?: string }>('/api/v1/safe/deploy'),

  safeConfig: () => gpFetch<GpSafeConfig>('/api/v1/safe/config'),
};
