import type { Env } from '../types';
import { sendAlert } from '../alerts';

/// Durable delivery of outbound merchant webhooks (migration 0015).
///
/// Every event is INSERTed into `webhook_outbox` first (primary key = the
/// Standard Webhooks `webhook-id`, so a repeated enqueue is a no-op), then one
/// immediate attempt is made. Anything not delivered is retried by the cron on
/// RETRY_DELAYS_S. Receivers must dedup on `webhook-id` — a retry after a lost
/// 2xx response delivers the same id again, by design.
///
/// Response classes:
///   2xx                 → delivered
///   408, 429, 5xx, net  → retry (until MAX_ATTEMPTS, then failed + alert)
///   other 4xx           → failed immediately + alert (receiver rejected the
///                         payload; resending the same bytes cannot help)
///
/// The signature is computed at SEND time with a fresh `webhook-timestamp`:
/// receivers (pinka-webhook) reject timestamps outside a tolerance window, so
/// re-sending a stale signature would fail forever.

/// Delay before attempt N+1 after attempt N failed (index 0 = after attempt 1).
/// The cron ticks every 2 min, so the first retry lands 1–3 min later. Total
/// window ≈ 47 h.
export const RETRY_DELAYS_S = [60, 300, 900, 3_600, 3 * 3_600, 6 * 3_600, 12 * 3_600, 24 * 3_600];
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
const SEND_TIMEOUT_MS = 10_000;
const DUE_BATCH = 25;

export interface OutboxEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  tenantId?: string | null;
}

export interface OutboxRow {
  id: string;
  type: string;
  payload: string;
  tenant_id: string | null;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  next_attempt_at: number;
  last_status: number | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
}

export interface SendResult {
  status: number | null;
  error?: string;
}

export interface OutboxDeps {
  /// true when the row was inserted, false when the id already existed.
  insert(row: OutboxRow): Promise<boolean>;
  listDue(nowUnix: number, limit: number): Promise<OutboxRow[]>;
  markDelivered(id: string, attempts: number, status: number, nowUnix: number): Promise<void>;
  markRetry(id: string, attempts: number, nextAt: number, status: number | null, error: string | null): Promise<void>;
  markFailed(id: string, attempts: number, status: number | null, error: string | null): Promise<void>;
  send(id: string, body: string): Promise<SendResult>;
  alert(text: string): Promise<void>;
}

export function classifyResponse(status: number | null): 'delivered' | 'retry' | 'permanent' {
  if (status === null) return 'retry';
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'permanent';
}

/// When to try again after `attempts` failed attempts; null = exhausted.
export function nextAttemptAt(attempts: number, nowUnix: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return nowUnix + RETRY_DELAYS_S[Math.max(0, attempts - 1)];
}

/// Persist, then try once right away. Returns what happened to this call's
/// attempt ('duplicate' = the id was already enqueued earlier; nothing sent).
export async function enqueueAndDeliver(
  deps: OutboxDeps,
  evt: OutboxEvent,
  nowUnix: number,
): Promise<'delivered' | 'retry' | 'failed' | 'duplicate'> {
  const row: OutboxRow = {
    id: evt.id,
    type: evt.type,
    payload: JSON.stringify(evt.payload),
    tenant_id: evt.tenantId ?? null,
    status: 'pending',
    attempts: 0,
    // Parked one retry-interval ahead so the cron cannot pick the row up
    // while this immediate attempt is still in flight.
    next_attempt_at: nowUnix + RETRY_DELAYS_S[0],
    last_status: null,
    last_error: null,
    created_at: nowUnix,
    delivered_at: null,
  };
  if (!(await deps.insert(row))) return 'duplicate';
  return attemptDelivery(deps, row, nowUnix);
}

export async function attemptDelivery(
  deps: OutboxDeps,
  row: OutboxRow,
  nowUnix: number,
): Promise<'delivered' | 'retry' | 'failed'> {
  const res = await deps.send(row.id, row.payload);
  const attempts = row.attempts + 1;
  const cls = classifyResponse(res.status);
  if (cls === 'delivered') {
    await deps.markDelivered(row.id, attempts, res.status!, nowUnix);
    return 'delivered';
  }
  const next = cls === 'retry' ? nextAttemptAt(attempts, nowUnix) : null;
  if (next !== null) {
    await deps.markRetry(row.id, attempts, next, res.status, res.error ?? null);
    return 'retry';
  }
  await deps.markFailed(row.id, attempts, res.status, res.error ?? null);
  await deps.alert(
    `📭 <b>Merchant webhook NIJE isporučen</b>\n` +
      `event: <code>${row.type}</code> · id: <code>${row.id}</code>\n` +
      `pokušaja: ${attempts} · zadnji status: <code>${res.status ?? 'network'}</code>\n` +
      `greška: <code>${(res.error ?? '-').slice(0, 200)}</code>\n` +
      `Ponovi iz admina: POST /admin/api/outbox/${row.id}/resend`,
  );
  return 'failed';
}

/// Cron: retry everything that is due. Cheap on an empty set.
export async function deliverDue(
  deps: OutboxDeps,
  nowUnix: number,
): Promise<{ due: number; delivered: number; failed: number }> {
  const rows = await deps.listDue(nowUnix, DUE_BATCH);
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    const r = await attemptDelivery(deps, row, nowUnix);
    if (r === 'delivered') delivered++;
    else if (r === 'failed') failed++;
  }
  return { due: rows.length, delivered, failed };
}

// ---- Env wiring -----------------------------------------------------------

/// The endpoint is resolved at send time. Today there is one global endpoint
/// (INTENT_WEBHOOK_URL); a per-tenant endpoint only needs this function to
/// look at `tenant_id`.
function endpoint(env: Env): { url: string; secret: string } | null {
  const url = env.INTENT_WEBHOOK_URL?.trim();
  const secret = env.INTENT_WEBHOOK_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

export function outboxConfigured(env: Env): boolean {
  return endpoint(env) !== null;
}

export function makeOutboxDeps(env: Env): OutboxDeps {
  return {
    async insert(row) {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO webhook_outbox
           (id, type, payload, tenant_id, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
        .bind(row.id, row.type, row.payload, row.tenant_id, row.next_attempt_at, row.created_at)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },
    async listDue(now, limit) {
      const res = await env.DB.prepare(
        `SELECT * FROM webhook_outbox
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at LIMIT ?`,
      )
        .bind(now, limit)
        .all<OutboxRow>();
      return res.results;
    },
    async markDelivered(id, attempts, status, now) {
      await env.DB.prepare(
        `UPDATE webhook_outbox
            SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ?
          WHERE id = ?`,
      ).bind(attempts, status, now, id).run();
    },
    async markRetry(id, attempts, nextAt, status, error) {
      await env.DB.prepare(
        `UPDATE webhook_outbox
            SET attempts = ?, next_attempt_at = ?, last_status = ?, last_error = ?
          WHERE id = ?`,
      ).bind(attempts, nextAt, status, error, id).run();
    },
    async markFailed(id, attempts, status, error) {
      await env.DB.prepare(
        `UPDATE webhook_outbox
            SET status = 'failed', attempts = ?, last_status = ?, last_error = ?
          WHERE id = ?`,
      ).bind(attempts, status, error, id).run();
    },
    send: (id, body) => signedPost(env, id, body),
    alert: (text) => sendAlert(env, text),
  };
}

/// Enqueue + immediate attempt. Silent no-op when no endpoint is configured
/// (the rail then simply doesn't notify, as before the outbox). Never throws:
/// callers sit on money paths.
export async function enqueueWebhook(env: Env, evt: OutboxEvent): Promise<void> {
  if (!outboxConfigured(env)) return;
  try {
    const r = await enqueueAndDeliver(makeOutboxDeps(env), evt, Math.floor(Date.now() / 1000));
    if (r !== 'delivered' && r !== 'duplicate') {
      console.warn(`webhook ${evt.id} (${evt.type}) not delivered on first attempt → ${r}`);
    }
  } catch (e) {
    console.error(`webhook ${evt.id} enqueue failed: ${(e as Error).message}`);
  }
}

/// Admin resend: put a delivered/failed row back in the queue and try now.
export async function resendWebhook(env: Env, id: string): Promise<'delivered' | 'retry' | 'failed' | 'not_found'> {
  const row = await env.DB.prepare(`SELECT * FROM webhook_outbox WHERE id = ?`).bind(id).first<OutboxRow>();
  if (!row) return 'not_found';
  await env.DB.prepare(
    `UPDATE webhook_outbox SET status = 'pending', attempts = 0 WHERE id = ?`,
  ).bind(id).run();
  return attemptDelivery(makeOutboxDeps(env), { ...row, status: 'pending', attempts: 0 }, Math.floor(Date.now() / 1000));
}

async function signedPost(env: Env, id: string, body: string): Promise<SendResult> {
  const ep = endpoint(env);
  if (!ep) return { status: null, error: 'endpoint_not_configured' };
  const keyBytes = decodeWebhookSecret(ep.secret);
  if (!keyBytes) return { status: null, error: 'invalid INTENT_WEBHOOK_SECRET format' };
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacSha256Base64(keyBytes, `${id}.${timestamp}.${body}`);
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signature}`,
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) return { status: res.status };
    const text = await res.text().catch(() => '');
    return { status: res.status, error: text.slice(0, 500) || res.statusText };
  } catch (e) {
    return { status: null, error: (e as Error).message };
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
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
