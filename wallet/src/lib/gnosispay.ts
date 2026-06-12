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
  // Eksplicitni override (staging prije partner registracije): GP whitelistu
  // provjerava ISKLJUČIVO nad domain poljem potpisane poruke, ne nad stvarnim
  // originom requesta — pa build s VITE_GP_SIWE_DOMAIN=<demo domena> radi s
  // bilo kojeg hosta. Maknuti nakon TODO-MATIJA #1 (vlastiti whitelist).
  const override = import.meta.env.VITE_GP_SIWE_DOMAIN as string | undefined;
  if (override) return { domain: override, uri: `https://${override}` };
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
async function signHashWithPasskey1271(passkey: PasskeyRecord, dataHash: Hex): Promise<Hex> {
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

function signSiweWithPasskey(passkey: PasskeyRecord, message: string): Promise<Hex> {
  return signHashWithPasskey1271(passkey, hashMessage(message));
}

/**
 * Potpiši GP ModuleTx typed-data paket (withdraw / daily limit / owner add)
 * passkeyem kao Safe ERC-1271. GP-u uz potpis ide i `smartWalletAddress`
 * (naš Safe) — bez njega verifier tretira potpis kao EOA ECDSA i pada.
 */
export async function signGpModuleTx(
  typedData: GpModuleTxTypedData,
): Promise<{ signature: Hex; message: GpModuleTxTypedData['message']; smartWalletAddress: Address }> {
  const passkey = getActivePasskey();
  if (!passkey) throw new Error('Nema aktivnog passkeya');
  const dataHash = hashTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
  const signature = await signHashWithPasskey1271(passkey, dataHash);
  return { signature, message: typedData.message, smartWalletAddress: passkey.safeAddress };
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

// ── Faza 2 tipovi (kartice, balansi, ModuleTx operacije) ──────────────────────

export type GpCard = {
  id: string;
  cardToken: string;
  lastFourDigits: string;
  activatedAt: string | null;
  virtual: boolean;
  statusCode: number;
  statusName?: string;
};

export type GpCardStatus = {
  statusCode: number;
  isFrozen: boolean;
  isStolen: boolean;
  isLost: boolean;
  isBlocked: boolean;
  isVoid: boolean;
  activatedAt?: string;
};

/** Svi iznosi su stringovi u base units tokena (EURe = 18 decimala). */
export type GpBalances = { total: string; spendable: string; pending: string };

/** EIP-712 paket koji GP vraća za Delay-module operacije (withdraw, limit,
 * owner add/remove). Potpisuje ga Delay-owner — kod nas DOMOVINA Safe (1271). */
export type GpModuleTxTypedData = {
  domain: { verifyingContract: Address; chainId: number };
  primaryType: 'ModuleTx';
  types: Record<string, { type: string; name: string }[]>;
  message: { data: Hex; salt: Hex };
};

export type GpDelayTx = {
  id: string;
  safeAddress: Address;
  transactionData: Hex;
  operationType: 'CALL' | 'DELEGATECALL';
  userId: string;
  status: 'QUEUING' | 'WAITING' | 'EXECUTING' | 'EXECUTED' | 'FAILED';
  createdAt: string;
  readyAt?: string;
};

export type GpCardTxEvent = {
  kind: 'Payment' | 'Refund' | 'Reversal';
  threadId: string;
  createdAt: string;
  clearedAt?: string | null;
  isPending: boolean;
  mcc?: string;
  merchant?: { name: string; city?: string; country?: string };
  /** Minor units string (npr. '2550' uz decimals 2 = 25,50). */
  billingAmount: string;
  billingCurrency: { symbol: string; code: string; decimals: number; name?: string };
  status?: string;
  cardToken?: string;
  transactions?: { status?: string; to?: string; value?: string; hash?: Hex }[];
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

  // ── Faza 2: kartice ─────────────────────────────────────────────────────────

  /** 201 {cardId}; 409 = narudžba u tijeku; 422 = preduvjeti (max 5 kartica…). */
  createVirtualCard: () => gpFetch<{ cardId: string }>('/api/v1/cards/virtual', { method: 'POST' }),

  cards: () => gpFetch<GpCard[]>('/api/v1/cards'),

  cardStatus: (cardId: string) => gpFetch<GpCardStatus>(`/api/v1/cards/${cardId}/status`),

  freezeCard: (cardId: string) =>
    gpFetch<{ status: string }>(`/api/v1/cards/${cardId}/freeze`, { method: 'POST' }),

  unfreezeCard: (cardId: string) =>
    gpFetch<{ status: string }>(`/api/v1/cards/${cardId}/unfreeze`, { method: 'POST' }),

  /** Samo virtualne; terminalno. */
  voidCard: (cardId: string) =>
    gpFetch<{ status: string }>(`/api/v1/cards/${cardId}/void`, { method: 'POST' }),

  reportCardLost: (cardId: string) =>
    gpFetch<{ status: string }>(`/api/v1/cards/${cardId}/lost`, { method: 'POST' }),

  reportCardStolen: (cardId: string) =>
    gpFetch<{ status: string }>(`/api/v1/cards/${cardId}/stolen`, { method: 'POST' }),

  // ── Faza 2: balansi, withdraw, limit, owneri (ModuleTx + 1271) ──────────────

  balances: () => gpFetch<GpBalances>('/api/v1/account-balances'),

  withdrawTransactionData: (tokenAddress: Address, to: Address, amount: bigint) =>
    gpFetch<{ data: GpModuleTxTypedData }>(
      `/api/v1/accounts/withdraw/transaction-data?tokenAddress=${tokenAddress}&to=${to}&amount=${amount}`,
    ),

  withdraw: (args: {
    tokenAddress: Address;
    to: Address;
    amount: bigint;
    signature: Hex;
    message: GpModuleTxTypedData['message'];
    smartWalletAddress: Address;
  }) =>
    gpFetch<{ data: GpDelayTx }>('/api/v1/accounts/withdraw', {
      method: 'POST',
      body: JSON.stringify({ ...args, amount: args.amount.toString() }),
    }),

  /** {dailyLimit, dailyRemaining} u whole token units (1–8000). */
  dailyLimit: () =>
    gpFetch<{ data: { dailyLimit: number; dailyRemaining: number } }>(
      '/api/v1/accounts/daily-limit',
    ),

  dailyLimitTransactionData: (newLimit: number) =>
    gpFetch<{ data: GpModuleTxTypedData }>(
      `/api/v1/accounts/daily-limit/transaction-data?newLimit=${newLimit}`,
    ),

  setDailyLimit: (args: {
    newLimit: number;
    signature: Hex;
    message: GpModuleTxTypedData['message'];
    smartWalletAddress: Address;
  }) =>
    gpFetch<{ data: GpDelayTx }>('/api/v1/accounts/daily-limit', {
      method: 'PUT',
      body: JSON.stringify(args),
    }),

  owners: () => gpFetch<{ data: { owners: Address[] } }>('/api/v1/owners'),

  addOwnerTransactionData: (newOwner: Address) =>
    gpFetch<{ data: GpModuleTxTypedData }>(
      `/api/v1/owners/add/transaction-data?newOwner=${newOwner}`,
    ),

  addOwner: (args: {
    newOwner: Address;
    signature: Hex;
    message: GpModuleTxTypedData['message'];
    smartWalletAddress: Address;
  }) =>
    gpFetch<{ data: GpDelayTx }>('/api/v1/owners', {
      method: 'POST',
      body: JSON.stringify(args),
    }),

  /** Sve Delay-module operacije u redu/izvršene — polling nakon withdraw/limit/owner. */
  delayRelay: () => gpFetch<GpDelayTx[]>('/api/v1/delay-relay'),

  safeMigration: () =>
    gpFetch<{
      migrationId: string;
      status?: string | null;
      hasOldSafe: boolean;
      newSafe?: { address: Address };
      oldSafe?: { address: Address };
    }>('/api/v1/safe/migration'),

  cardTransactions: (limit = 25, offset = 0) =>
    gpFetch<{ count: number; next?: string | null; results: GpCardTxEvent[] }>(
      `/api/v1/cards/transactions?limit=${Math.max(limit, 10)}&offset=${offset}`,
    ),
};

/**
 * Adresa GP Safe-a za punjenje. NIKAD se ne hardkodira niti kešira preko
 * sesije: GP migracije (`safe-replacement-*`) mijenjaju adresu — prije svakog
 * punjenja čitati svježe iz /user + provjeriti aktivnu migraciju.
 */
export async function resolveGpSafeAddress(): Promise<Address | null> {
  const user = await gpApi.user();
  let addr = user.safeWallets[0]?.address ?? null;
  try {
    const mig = await gpApi.safeMigration();
    if (mig.newSafe?.address && mig.status === 'COMPLETED') addr = mig.newSafe.address;
  } catch {
    /* migracijski endpoint je advisory — bez njega vrijedi /user */
  }
  return addr;
}
