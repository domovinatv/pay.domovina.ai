/// Envelope encryption for per-tenant secrets stored in D1 (ADR 0017).
///
/// Monerium client secrets, webhook secrets and router EOA keys of tenants
/// other than ITalk live in `tenant_rail`, encrypted with AES-256-GCM under a
/// key-encryption key held in the Worker secret `TENANT_SECRETS_KEK`
/// (base64 of 32 random bytes — `openssl rand -base64 32`).
///
/// Wire format: `v1:<iv base64>:<ciphertext+tag base64>` (format version).
///
/// KEK rotation (MT-06, docs/runbook/kek-rotation.md): put the new key in
/// TENANT_SECRETS_KEK and the old one in TENANT_SECRETS_KEK_PREV. Decryption
/// tries the current key, then the previous one — GCM authentication says
/// which is right, so no key id is needed in the blob. New writes always use
/// the current key; `rewrap` re-encrypts stored rows, after which PREV can go.
///
/// AAD = `<tenantId>|<field>`. A ciphertext is therefore only decryptable as
/// the exact field of the exact tenant it was written for: copying tenant Y's
/// `client_secret_enc` into tenant X's row (or into X's `router_key_enc`)
/// fails authentication instead of silently handing X the other tenant's
/// credentials. Tenant isolation holds at the crypto layer too.
///
/// Honest limit: whoever compromises the Worker also has the KEK. That is why
/// the forward path has an on-chain layer (Zodiac Roles scope) the Worker
/// cannot widen.

export type SecretField =
  | 'client_secret'
  | 'refresh_token'
  | 'router_key'
  | 'webhook_secret'
  | 'outbound_webhook_secret';

const VERSION = 'v1';
const IV_BYTES = 12;

export class SecretsError extends Error {}

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/// Imports the KEK. Throws on a missing or malformed secret — callers on the
/// money path treat that as "tenant has no usable rail" (fail-closed).
export async function importKek(raw: string | undefined): Promise<CryptoKey> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new SecretsError('TENANT_SECRETS_KEK is not set');
  let bytes: Uint8Array;
  try {
    bytes = b64decode(trimmed);
  } catch {
    throw new SecretsError('TENANT_SECRETS_KEK is not valid base64');
  }
  if (bytes.byteLength !== 32) {
    throw new SecretsError(`TENANT_SECRETS_KEK must be 32 bytes, got ${bytes.byteLength}`);
  }
  return crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/// Current KEK first, then TENANT_SECRETS_KEK_PREV if set. A malformed PREV
/// is an error (a typo must not silently make old rows unreadable later).
export async function importKeks(env: {
  TENANT_SECRETS_KEK?: string;
  TENANT_SECRETS_KEK_PREV?: string;
}): Promise<CryptoKey[]> {
  const keys = [await importKek(env.TENANT_SECRETS_KEK)];
  if ((env.TENANT_SECRETS_KEK_PREV ?? '').trim()) keys.push(await importKek(env.TENANT_SECRETS_KEK_PREV));
  return keys;
}

function aad(tenantId: string, field: SecretField): Uint8Array {
  return new TextEncoder().encode(`${tenantId}|${field}`);
}

export async function encryptSecret(
  kek: CryptoKey,
  tenantId: string,
  field: SecretField,
  plaintext: string,
): Promise<string> {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(tenantId, field) as BufferSource },
    kek,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}:${b64encode(iv)}:${b64encode(new Uint8Array(ct))}`;
}

export async function decryptSecret(
  kek: CryptoKey | CryptoKey[],
  tenantId: string,
  field: SecretField,
  blob: string,
): Promise<string> {
  const parts = blob.split(':');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new SecretsError(`unsupported secret format for ${tenantId}.${field}`);
  }
  for (const key of Array.isArray(kek) ? kek : [kek]) {
    try {
      const pt = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: b64decode(parts[1]) as BufferSource,
          additionalData: aad(tenantId, field) as BufferSource,
        },
        key,
        b64decode(parts[2]) as BufferSource,
      );
      return new TextDecoder().decode(pt);
    } catch {
      // Try the next key (rotation window).
    }
  }
  // Wrong KEK(s), tampered ciphertext, or a blob that belongs to another
  // tenant/field. Deliberately one message: never hint which.
  throw new SecretsError(`cannot decrypt ${tenantId}.${field}`);
}
