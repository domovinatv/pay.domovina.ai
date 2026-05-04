import type { MoneriumOrder, MoneriumWebhookEvent } from './types';

/// Standard Webhooks (svix-compatible) signature verification, as documented
/// at docs.monerium.com/private#webhooks. Headers Monerium sends:
///
///   webhook-id:        unique event id (used for idempotency)
///   webhook-timestamp: unix seconds at delivery
///   webhook-signature: space-separated `vN,<base64>` tokens (rotation-friendly)
///
/// Signed payload: `${webhook-id}.${webhook-timestamp}.${rawBody}`
/// Algorithm:      HMAC-SHA256
/// Key:            base64-decode(secret.slice('whsec_'.length))
/// Encoding:       base64
///
/// We accept a match against any of the comma-separated tokens prefixed `v1,`
/// to support secret rotation.
export interface VerifyResult {
  ok: boolean;
  webhookId: string | null;
  reason?: string;
  /// Debug info logged when signature fails so we can diff against Monerium.
  debug?: {
    receivedSig: string;
    expectedSig: string;
    signedPayloadPreview: string;
    keyByteLength: number;
    headerCount: Record<string, string | null>;
  };
}

export async function verifyWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): Promise<VerifyResult> {
  if (!secret) return { ok: false, webhookId: null, reason: 'no secret configured' };
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatureHeader = headers.get('webhook-signature');
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, webhookId: id, reason: 'missing webhook-* headers' };
  }
  const keyBytes = decodeWebhookSecret(secret);
  if (!keyBytes) {
    return { ok: false, webhookId: id, reason: 'invalid secret format' };
  }
  const signedPayload = `${id}.${timestamp}.${rawBody}`;
  const expectedB64 = await hmacSha256Base64(keyBytes, signedPayload);
  // Header may carry multiple versioned signatures: "v1,abc v1,def v2,..."
  const tokens = signatureHeader.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const [version, sig] = token.split(',', 2);
    if (version === 'v1' && sig && timingSafeEqualString(sig, expectedB64)) {
      return { ok: true, webhookId: id };
    }
  }
  return {
    ok: false,
    webhookId: id,
    reason: 'no matching signature',
    debug: {
      receivedSig: signatureHeader,
      expectedSig: `v1,${expectedB64}`,
      signedPayloadPreview:
        signedPayload.length > 200
          ? `${signedPayload.slice(0, 200)}…[+${signedPayload.length - 200}b]`
          : signedPayload,
      keyByteLength: keyBytes.byteLength,
      headerCount: {
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'content-type': headers.get('content-type'),
        'user-agent': headers.get('user-agent'),
      },
    },
  };
}

function decodeWebhookSecret(secret: string): Uint8Array | null {
  const stripped = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  try {
    const bin = atob(stripped);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacSha256Base64(
  key: Uint8Array,
  data: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(data),
  );
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/// Pulls the order out of a webhook envelope. Monerium uses `data` for the
/// resource per Standard Webhooks; older payloads sometimes used `order`.
export function extractOrder(
  event: MoneriumWebhookEvent,
): MoneriumOrder | null {
  return event.data ?? event.order ?? null;
}

export function extractEventType(event: MoneriumWebhookEvent): string {
  return event.type ?? event.event ?? 'unknown';
}
