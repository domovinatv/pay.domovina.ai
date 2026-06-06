import { extractPasskeyData } from '@safe-global/protocol-kit';
import { RP_ID } from './constants';
import { brand } from '../app/brand';

export type P256PublicKey = {
  x: bigint;
  y: bigint;
};

/** Pre-Phase B (parent-RP) wallets were created with the subdomain as RP ID.
 * Records from that era don't carry an `rpId` field; we assume this value
 * for any record where rpId is missing. */
export const LEGACY_RP_ID = 'wallet.domovina.ai' as const;

export type PasskeyRecord = {
  credentialId: string;
  pubKey: { x: string; y: string };
  signerAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  createdAt: string;
  /**
   * 4-char identifier (legacy field, pre-rename UX). Older records have
   * this; newer records use `keychainName` instead. Kept for back-compat
   * so existing wallets keep rendering after the schema change.
   */
  nameSuffix?: string;
  /**
   * Full label the user sees in Apple Passwords / iCloud Keychain /
   * Google Password Manager — exactly what we passed as user.name /
   * user.displayName at navigator.credentials.create time. Empty / absent
   * on older records; UI must fall back to nameSuffix → 'Safe'.
   */
  keychainName?: string;
  /**
   * The WebAuthn Relying Party ID this credential was created under. WebAuthn
   * `get()` calls MUST pass a matching rpId; the browser does not do implicit
   * parent/child fall-through. Missing on legacy records, which all used
   * LEGACY_RP_ID. New records record whatever RP_ID derived to at create time
   * (currently `domovina.ai` for any *.domovina.ai page — see constants.ts).
   */
  rpId?: string;
};

export function recordRpId(record: PasskeyRecord): string {
  return record.rpId ?? LEGACY_RP_ID;
}

const STORAGE_KEY_V1 = 'domovina_wallet_v1';
const STORAGE_KEY_V2 = 'domovina_wallets_v2';
const ACTIVE_KEY = 'domovina_active_wallet';

type WalletRegistry = Record<string, PasskeyRecord>;

/// Ensure all credentialId fields in the registry use the canonical
/// "0x" + lowercase-hex format. Early wallet builds saved them as plain hex
/// (no prefix) because protocol-kit returns that form from extractPasskeyData.
/// Run on every load; no-op once everything's already normalized.
function normalizeCredentialId(id: string): string {
  const lower = id.toLowerCase();
  return lower.startsWith('0x') ? lower : '0x' + lower;
}

function migrateRegistryShape(reg: WalletRegistry): { changed: boolean; reg: WalletRegistry } {
  let changed = false;
  const next: WalletRegistry = {};
  for (const [key, value] of Object.entries(reg)) {
    const canonical = normalizeCredentialId(value.credentialId ?? key);
    if (canonical !== key || canonical !== value.credentialId) {
      changed = true;
    }
    next[canonical] = { ...value, credentialId: canonical };
  }
  return { changed, reg: next };
}

function loadRegistry(): WalletRegistry {
  // One-time migration from v1 (single wallet) to v2 (keyed registry).
  const v1Raw = localStorage.getItem(STORAGE_KEY_V1);
  if (v1Raw) {
    try {
      const v1 = JSON.parse(v1Raw) as PasskeyRecord;
      const v2Raw = localStorage.getItem(STORAGE_KEY_V2);
      const v2: WalletRegistry = v2Raw ? JSON.parse(v2Raw) : {};
      const canonicalId = normalizeCredentialId(v1.credentialId);
      if (!v2[canonicalId]) {
        v2[canonicalId] = {
          ...v1,
          credentialId: canonicalId,
          createdAt: v1.createdAt ?? new Date().toISOString(),
        };
        localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(v2));
        localStorage.setItem(ACTIVE_KEY, canonicalId);
      }
      localStorage.removeItem(STORAGE_KEY_V1);
    } catch {
      /* malformed v1, just discard */
      localStorage.removeItem(STORAGE_KEY_V1);
    }
  }
  const raw = localStorage.getItem(STORAGE_KEY_V2);
  const reg: WalletRegistry = raw ? (JSON.parse(raw) as WalletRegistry) : {};
  const migrated = migrateRegistryShape(reg);
  if (migrated.changed) {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(migrated.reg));
    const activeRaw = localStorage.getItem(ACTIVE_KEY);
    if (activeRaw) {
      const canonicalActive = normalizeCredentialId(activeRaw);
      if (canonicalActive !== activeRaw) localStorage.setItem(ACTIVE_KEY, canonicalActive);
    }
  }
  return migrated.reg;
}

function saveRegistry(reg: WalletRegistry): void {
  localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(reg));
}

export function listKnownPasskeys(): PasskeyRecord[] {
  return Object.values(loadRegistry()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getActivePasskey(): PasskeyRecord | null {
  const reg = loadRegistry();
  const activeId = localStorage.getItem(ACTIVE_KEY);
  if (activeId && reg[activeId]) return reg[activeId];
  // No explicit active wallet but registry has entries — pick first
  const all = Object.values(reg);
  return all.length === 1 ? all[0] : null;
}

export function setActivePasskey(credentialId: string): void {
  localStorage.setItem(ACTIVE_KEY, credentialId);
}

export function savePasskey(record: PasskeyRecord): void {
  const reg = loadRegistry();
  reg[record.credentialId] = record;
  saveRegistry(reg);
  setActivePasskey(record.credentialId);
}

export function lookupPasskey(credentialId: string): PasskeyRecord | null {
  return loadRegistry()[credentialId] ?? null;
}

export function clearAllPasskeys(): void {
  localStorage.removeItem(STORAGE_KEY_V2);
  localStorage.removeItem(ACTIVE_KEY);
}

/**
 * Soft-delete: remove the record from the local registry so it stops showing
 * up in the wallet picker. The underlying passkey in iCloud Keychain / Google
 * Password Manager is untouched, and the Safe / signer onchain are untouched
 * — the user can always re-discover this wallet via "Otvori postojeći passkey"
 * (OS picker → lookupWallet from backend → savePasskey restores it).
 *
 * If the archived wallet was the active one, falls active over to the most
 * recently created remaining wallet, or clears active if none remain.
 */
export function archivePasskey(credentialId: string): void {
  const reg = loadRegistry();
  if (!reg[credentialId]) return;
  delete reg[credentialId];
  saveRegistry(reg);
  const wasActive = localStorage.getItem(ACTIVE_KEY) === credentialId;
  if (wasActive) {
    const remaining = Object.values(reg).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    if (remaining[0]) {
      localStorage.setItem(ACTIVE_KEY, remaining[0].credentialId);
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
  }
}

// Track the currently-in-flight WebAuthn call so a stale one (e.g. iOS Safari
// not releasing its "pending" state after dismiss) doesn't block a fresh
// request with `NotAllowedError: A request is already pending`.
let currentWebAuthnAbort: AbortController | null = null;
let webAuthnCallCounter = 0;

function nextWebAuthnSignal(label: string): { signal: AbortSignal; id: number } {
  const id = ++webAuthnCallCounter;
  if (currentWebAuthnAbort) {
    console.warn(`[passkey] aborting previous WebAuthn call before #${id} (${label})`);
    currentWebAuthnAbort.abort();
  }
  const ctrl = new AbortController();
  currentWebAuthnAbort = ctrl;
  console.log(`[passkey] WebAuthn call #${id} START (${label})`);
  return { signal: ctrl.signal, id };
}

function clearAbortIfCurrent(signal: AbortSignal, id: number, label: string): void {
  console.log(`[passkey] WebAuthn call #${id} END (${label})`);
  if (currentWebAuthnAbort && currentWebAuthnAbort.signal === signal) {
    currentWebAuthnAbort = null;
  }
}

/** Suggest a default passkey label for a fresh enrollment. The caller
 * (Landing.tsx) prefills its input with this so the user sees a sensible
 * default but can rename before the Face ID prompt fires.
 *
 * Format: `<brand productName> · DD.M.YYYY`. The brand prefix anchors
 * the entry visually in OS keychain lists across all *.domovina.ai
 * sites (Phase B RP = domovina.ai); date suffix keeps every default
 * label unique without exposing a meaningless hex blob. */
export function suggestPasskeyName(): string {
  const d = new Date();
  const datePart = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
  return `${brand.copy.productName} · ${datePart}`;
}

/** Common purpose suggestions surfaced as one-tap chips in the naming
 * step. Tapping a chip replaces the input with `DOMOVINA Wallet · X`,
 * so the user gets a semantic name without typing. Order matters —
 * "Glavni" first because it is by far the common case. */
export const PASSKEY_PURPOSE_SUGGESTIONS: readonly string[] = [
  'Glavni',
  'Ušteđevina',
  'Firma',
  'Test',
  'Pokloni',
];

/** Build the full keychain label from a short purpose tag.
 * Returns the brand-prefixed string the OS keychain will display. */
export function purposeToKeychainName(purpose: string): string {
  return `${brand.copy.productName} · ${purpose}`;
}

/** Single-word, alphanumeric brand token for the address-as-name flow.
 * "DOMOVINA Wallet" → "DOMOVINA". No spaces/punctuation so the keychain
 * label is a clean `BRAND_0x…` string with no special characters. */
function brandToken(): string {
  return (brand.name.split(/\s+/)[0] || 'Wallet').replace(/[^A-Za-z0-9]/g, '');
}

/** Keychain label for the ADR-0011 "passkey name = Safe address" flow:
 * `<BRAND>_<full safe address>` (e.g. `DOMOVINA_0x1234…cdef`). The full
 * address is the portable, synced, immutable account identity; the brand
 * token groups the entry. Fits the 64-char cap (9 + 42 = 51). Deliberately
 * uses an underscore and no `·`/special chars — exact-match friendly across
 * every password manager. See docs/decisions/0011-*.md. */
export function addressKeychainName(safeAddress: string): string {
  return `${brandToken()}_${safeAddress}`;
}

export async function createPasskey(
  label?: string,
): Promise<{
  credentialId: string;
  pubKey: P256PublicKey;
  keychainName: string;
  rpId: string;
}> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  // The label is what the user sees in iCloud Keychain / Google Password
  // Manager and in our own UI. If the caller didn't pass one (e.g. legacy
  // call site), fall back to a randomized DOMOVINA wa_xxxx so the entry
  // is still distinguishable from other passkeys.
  const friendlyLabel = (label?.trim() || suggestPasskeyName()).slice(0, 64);

  const { signal, id: __callId } = nextWebAuthnSignal('signWithPasskey/create/pick');
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: RP_ID, name: brand.name },
        user: { id: userId, name: friendlyLabel, displayName: friendlyLabel },
        challenge,
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' },   // ES256 — what we actually use
          { alg: -257, type: 'public-key' }, // RS256 — listed only to silence Chromium warning
        ],
        authenticatorSelection: {
          userVerification: 'required',
          residentKey: 'required',
        },
        attestation: 'none',
        timeout: 60_000,
      },
      signal,
    })) as PublicKeyCredential | null;
  } finally {
    clearAbortIfCurrent(signal, __callId, 'WebAuthn op');
  }

  if (!cred) throw new Error('Passkey creation cancelled');

  const data = await extractPasskeyData(cred);
  // protocol-kit returns rawId as plain lowercase hex without 0x prefix.
  // Normalize to our canonical "0x" + hex form so it matches what
  // pickExistingPasskey produces and what the backend registry validates.
  const credentialId = data.rawId.startsWith('0x')
    ? data.rawId.toLowerCase()
    : '0x' + data.rawId.toLowerCase();
  return {
    credentialId,
    pubKey: { x: BigInt(data.coordinates.x), y: BigInt(data.coordinates.y) },
    keychainName: friendlyLabel,
    rpId: RP_ID,
  };
}

/** Run a discoverable-credential get() under a specific RP ID. Returns the
 * picked credentialId, or null if the user dismisses or no credentials exist
 * for that scope. */
async function pickForRpId(rpId: string, label: string): Promise<string | null> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const { signal, id: __callId } = nextWebAuthnSignal(`pickExistingPasskey/${label}`);
  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        rpId,
        challenge: challenge.buffer as ArrayBuffer,
        userVerification: 'required',
        timeout: 60_000,
      },
      signal,
    })) as PublicKeyCredential | null;
    if (!assertion) return null;
    return '0x' + bufToHex(assertion.rawId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/NotAllowed|cancelled|abort|timed out/i.test(msg)) return null;
    throw e;
  } finally {
    clearAbortIfCurrent(signal, __callId, 'WebAuthn op');
  }
}

/**
 * Discoverable-credential get: shows OS picker with passkeys for our RP ID
 * (across iCloud Keychain, LastPass, 1Password, Google PM, …). User picks one,
 * we return the credentialId from the assertion. Caller then looks it up in
 * the local registry to find pubKey + safeAddress.
 *
 * Default flow: try the current RP_ID first (e.g. `domovina.ai` post-Phase B),
 * then fall back to LEGACY_RP_ID on dismiss. The fallback is invisible to
 * users who picked something in the primary picker — they never see a
 * second prompt, and never reach their legacy passkeys this way. For that
 * case, callers pass { legacyOnly: true } to force the LEGACY_RP_ID picker
 * directly (wired to the "Stari wallet (prije svibnja 2026)" UI button).
 */
export async function pickExistingPasskey(
  opts: { legacyOnly?: boolean } = {},
): Promise<{ credentialId: string }> {
  if (opts.legacyOnly) {
    const legacy = await pickForRpId(LEGACY_RP_ID, 'legacy-only');
    if (legacy) return { credentialId: legacy };
    throw new Error('Passkey selection cancelled');
  }

  const primary = await pickForRpId(RP_ID, 'primary');
  if (primary) return { credentialId: primary };

  if (RP_ID !== LEGACY_RP_ID) {
    const legacy = await pickForRpId(LEGACY_RP_ID, 'legacy');
    if (legacy) return { credentialId: legacy };
  }

  throw new Error('Passkey selection cancelled');
}

export async function signWithPasskey(
  credentialId: string,
  challenge: Uint8Array,
  rpId: string,
): Promise<{
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { signal, id: __callId } = nextWebAuthnSignal(`signWithPasskey attempt ${attempt + 1}`);
    let assertion: PublicKeyCredential | null;
    try {
      assertion = (await navigator.credentials.get({
        publicKey: {
          // rpId is required per-record: legacy passkeys are scoped to
          // wallet.domovina.ai, parent-scoped ones to domovina.ai. The browser
          // does not fall through between them; callers must pass the rpId
          // recorded at create time (see PasskeyRecord.rpId).
          rpId,
          challenge: challenge.buffer as ArrayBuffer,
          allowCredentials: [{ id: hexToBuf(credentialId), type: 'public-key' }],
          userVerification: 'required',
          timeout: 60_000,
        },
        signal,
      })) as PublicKeyCredential | null;
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/already pending|pending/i.test(msg) && attempt < 2) {
        console.warn(`[passkey] OperationError on attempt ${attempt + 1}, retrying after delay…`);
        clearAbortIfCurrent(signal, __callId, 'retry');
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      clearAbortIfCurrent(signal, __callId, 'final fail');
      throw e;
    }
    clearAbortIfCurrent(signal, __callId, 'WebAuthn op');
    if (!assertion) throw new Error('Passkey signing cancelled');

    const response = assertion.response as AuthenticatorAssertionResponse;
    return {
      authenticatorData: new Uint8Array(response.authenticatorData),
      clientDataJSON: new Uint8Array(response.clientDataJSON),
      signature: new Uint8Array(response.signature),
    };
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function hexToBuf(hex: string): ArrayBuffer {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
