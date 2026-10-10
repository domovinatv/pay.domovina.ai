/// Signature checks and at-rest encryption. Every comparison of a secret-derived
/// value is constant-time; every input is the RAW bytes the sender signed
/// (Shopify and MPT both sign the exact body, so never re-serialise JSON).

const enc = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/// OAuth install/callback query HMAC: drop `hmac`, sort the rest, join as
/// `k=v&k=v`, hex HMAC-SHA256 with the app's client secret.
export async function verifyShopifyQueryHmac(params: URLSearchParams, clientSecret: string): Promise<boolean> {
  const given = params.get('hmac');
  if (!given) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const expected = bytesToHex(await hmacSha256(clientSecret, message));
  return timingSafeEqual(expected, given.toLowerCase());
}

/// Shopify webhook: base64 HMAC-SHA256 of the raw body in X-Shopify-Hmac-Sha256.
export async function verifyShopifyWebhook(rawBody: string, header: string | null, clientSecret: string): Promise<boolean> {
  if (!header) return false;
  const expected = bytesToBase64(await hmacSha256(clientSecret, rawBody));
  return timingSafeEqual(expected, header.trim());
}

/// MPT outbound webhook — Standard Webhooks (svix) scheme, the same one
/// backend/src/intents/outbox.ts signs with: `v1,<base64>` over
/// `${id}.${timestamp}.${body}`, secret `whsec_<base64>`. The header may carry
/// several space-separated signatures during secret rotation.
export async function verifyMptWebhook(args: {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  secret: string;
  nowUnix: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const { id, timestamp, signature, body, secret, nowUnix } = args;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowUnix - ts) > (args.toleranceSeconds ?? 300)) return false;
  const key = base64ToBytes(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret);
  if (!key) return false;
  const expected = bytesToBase64(await hmacSha256(key, `${id}.${timestamp}.${body}`));
  return signature
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .some((s) => timingSafeEqual(s.slice(3), expected));
}

/// The intent sid for a Shopify order. Deterministic so the orders/create
/// webhook and the Thank-you extension can race to create it and both land on
/// the same intent (the backend answers 409 to the loser). Keyed with a secret
/// because the sid is the read capability on the public intent API — a
/// guessable `shp_<orderId>` would let anyone enumerate order amounts.
export async function deriveSid(secret: string, shop: string, orderGid: string): Promise<string> {
  const mac = await hmacSha256(secret, `sid:v1:${shop}:${orderGid}`);
  // 32 chars total (BW-20): the MPT rail caps sids at 32 so they fit bytes32
  // on-chain. Not deployed before this change — no open orders carry the
  // old 36-char form.
  return `shp_${bytesToHex(mac).slice(0, 28)}`;
}

/// AES-256-GCM for Shopify access/refresh tokens, MPT tenant keys and webhook
/// secrets at rest in D1. Key = base64 of 32 random bytes (TOKEN_KEK secret).
async function importKek(kekB64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(kekB64.trim());
  if (!raw || raw.length !== 32) throw new Error('TOKEN_KEK must be base64 of 32 bytes');
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(kekB64: string, plaintext: string): Promise<string> {
  const key = await importKek(kekB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(ct)}`;
}

export async function decryptSecret(kekB64: string, stored: string): Promise<string> {
  const [v, ivB64, ctB64] = stored.split(':');
  const iv = base64ToBytes(ivB64 ?? '');
  const ct = base64ToBytes(ctB64 ?? '');
  if (v !== 'v1' || !iv || !ct) throw new Error('unsupported ciphertext format');
  const key = await importKek(kekB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
  return new TextDecoder().decode(pt);
}
