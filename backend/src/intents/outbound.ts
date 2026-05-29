import type { Env } from '../types';
import type { PaymentIntentRow } from './db';

/// Outbound "intent paid" webhook. When INTENT_WEBHOOK_URL + INTENT_WEBHOOK_SECRET
/// are configured, the rail POSTs a signed event to that URL the moment a payment
/// intent flips pending → paid (i.e. EURe was forwarded on-chain to the target).
///
/// This is the generic merchant-notification seam (per docs/product-vision/
/// per-event-safe-rail.md). pinka.finance uses it: the domovina-api `pinka-webhook`
/// edge function verifies the signature and calls
/// `pinka_finance.mark_contribution_paid(sid, tx_hash, amount_received_cents)`.
///
/// Signing mirrors the INBOUND Monerium scheme (Standard Webhooks / svix) so the
/// whole stack shares one mental model:
///   headers: webhook-id, webhook-timestamp, webhook-signature: `v1,<base64>`
///   signed payload: `${id}.${timestamp}.${rawBody}`
///   key: base64-decode(secret without optional `whsec_` prefix)
///
/// Best-effort + idempotent: webhook-id is stable per intent (`int_<sid>`), and the
/// receiver's mark-paid is itself idempotent, so duplicate deliveries are safe.
export async function emitIntentPaidWebhook(
  env: Env,
  intent: PaymentIntentRow,
): Promise<void> {
  const url = env.INTENT_WEBHOOK_URL?.trim();
  const secret = env.INTENT_WEBHOOK_SECRET?.trim();
  if (!url || !secret) return; // not configured — silent no-op

  const payload = {
    type: 'intent.paid',
    sid: intent.sid,
    state: intent.state,
    amount_cents: intent.amount_cents,
    amount_received_cents: intent.amount_received_cents,
    currency: intent.currency,
    target_address: intent.target_address,
    monerium_order_id: intent.monerium_order_id,
    forward_tx_hash: intent.forward_tx_hash,
    paid_at: intent.paid_at,
    metadata: intent.metadata_json ? safeParse(intent.metadata_json) : null,
  };
  const body = JSON.stringify(payload);
  const id = `int_${intent.sid}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const keyBytes = decodeWebhookSecret(secret);
  if (!keyBytes) {
    console.error('intent webhook: invalid INTENT_WEBHOOK_SECRET format');
    return;
  }
  const signature = await hmacSha256Base64(keyBytes, `${id}.${timestamp}.${body}`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signature}`,
      },
      body,
    });
    if (!res.ok) {
      console.error(`intent webhook ${id} → ${url} returned ${res.status}`);
    }
  } catch (e) {
    console.error(`intent webhook ${id} → ${url} failed: ${e}`);
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
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

async function hmacSha256Base64(key: Uint8Array, data: string): Promise<string> {
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
