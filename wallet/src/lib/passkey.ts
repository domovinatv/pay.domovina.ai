import { extractPasskeyData } from '@safe-global/protocol-kit';
import { RP_ID, RP_NAME } from './constants';

export type P256PublicKey = {
  x: bigint;
  y: bigint;
};

export type PasskeyRecord = {
  credentialId: string;
  pubKey: { x: string; y: string };
  signerAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  createdAt: string;
};

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

export async function createPasskey(label?: string): Promise<{ credentialId: string; pubKey: P256PublicKey }> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  // Disambiguate name when adding additional wallets so iCloud/1Password etc.
  // show distinct entries instead of a pile of identical "DOMOVINA Wallet"s.
  const existingCount = Object.keys(loadRegistry()).length;
  const friendlyLabel =
    label ??
    (existingCount === 0 ? 'DOMOVINA Wallet' : `DOMOVINA Wallet ${existingCount + 1}`);

  const { signal, id: __callId } = nextWebAuthnSignal('signWithPasskey/create/pick');
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: RP_ID, name: RP_NAME },
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
  };
}

/**
 * Discoverable-credential get: shows OS picker with ALL passkeys for our RP ID
 * (across iCloud Keychain, LastPass, 1Password, Google PM, …). User picks one,
 * we return the credentialId from the assertion. Caller then looks it up in
 * the local registry to find pubKey + safeAddress.
 */
export async function pickExistingPasskey(): Promise<{ credentialId: string }> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const { signal, id: __callId } = nextWebAuthnSignal('signWithPasskey/create/pick');
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: challenge.buffer as ArrayBuffer,
        // No allowCredentials = discoverable mode → picker shows everything.
        userVerification: 'required',
        timeout: 60_000,
      },
      signal,
    })) as PublicKeyCredential | null;
  } finally {
    clearAbortIfCurrent(signal, __callId, 'WebAuthn op');
  }
  if (!assertion) throw new Error('Passkey selection cancelled');
  // assertion.id is base64url-encoded credentialId; our registry uses
  // protocol-kit's hex-string format ("0x…"). Convert.
  const credentialId = '0x' + bufToHex(assertion.rawId);
  return { credentialId };
}

export async function signWithPasskey(
  credentialId: string,
  challenge: Uint8Array,
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
