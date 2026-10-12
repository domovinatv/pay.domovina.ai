import { Hono } from 'hono';

import type { Env } from '../types';
import { resolveRequestTenant } from '../tenants/auth';
import { getIntent } from '../intents/db';
import {
  SANDBOX_PER_IP_PER_DAY,
  countActiveSandboxTenants,
  countRecentByIp,
  countRecentSimulations,
  createSandboxTenant,
  hashIp,
  isSandboxTenant,
  maxSandboxTenants,
  sandboxEnabled,
  touchSandboxTenant,
  updateSandboxWebhook,
} from './db';
import { SIM_OUTCOMES, SIM_PER_TENANT_PER_DAY, simulatePayment, type SimOutcome } from './simulate';

/// Self-serve sandbox (ADR 0024). Off unless SANDBOX_SELF_SERVE=1: every
/// route then answers 404 as if it did not exist.

const MAX_NAME = 80;
const MAX_URL = 2048;
const DEMO_TARGET = '0x000000000000000000000000000000000000dEaD';

/// `https://` only, no credentials, no fragment. Returns the normalised URL
/// or null.
export function validateWebhookUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) return null;
  return u.toString();
}

async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  const secret = (env.SANDBOX_TURNSTILE_SECRET ?? '').trim();
  if (!secret) return true; // not provisioned → fail open, like the relayer
  if (typeof token !== 'string' || !token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    return Boolean(((await res.json()) as { success?: boolean }).success);
  } catch {
    return false; // operator opted in → fail closed
  }
}

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/// The sandbox tenant behind a `sk_test_` key, or an error response body.
async function sandboxSecretCaller(
  env: Env,
  headers: Headers,
): Promise<{ ok: true; tenantId: string } | { ok: false; status: 401 | 403; error: string }> {
  const r = await resolveRequestTenant(env, headers);
  if (!r.ok) return { ok: false, status: r.error === 'tenant_suspended' ? 403 : 401, error: r.error };
  if (!r.sandbox) return { ok: false, status: 403, error: 'sandbox_key_required' };
  if (r.keyKind !== 'secret') return { ok: false, status: 403, error: 'secret_key_required' };
  return { ok: true, tenantId: r.tenantId };
}

export function buildSandboxApi(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.use('*', async (c, next) => {
    if (!sandboxEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
    await next();
  });

  api.post('/tenants', async (c) => {
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME) return c.json({ error: 'invalid_name', max: MAX_NAME }, 400);
    let webhookUrl: string | null = null;
    if (body.webhook_url !== undefined && body.webhook_url !== null && body.webhook_url !== '') {
      webhookUrl = validateWebhookUrl(body.webhook_url);
      if (!webhookUrl) return c.json({ error: 'invalid_webhook_url' }, 400);
    }
    const ip = c.req.header('cf-connecting-ip') ?? null;
    if (!(await verifyTurnstile(c.env, body.turnstile_token, ip))) {
      return c.json({ error: 'turnstile_failed' }, 403);
    }
    const ipHash = await hashIp(c.env, ip ?? 'unknown');
    const t = Math.floor(Date.now() / 1000);
    if ((await countRecentByIp(c.env, ipHash, t - 86_400)) >= SANDBOX_PER_IP_PER_DAY) {
      return c.json({ error: 'rate_limited', limit: SANDBOX_PER_IP_PER_DAY, window: '24h' }, 429);
    }
    if ((await countActiveSandboxTenants(c.env)) >= maxSandboxTenants(c.env)) {
      return c.json({ error: 'sandbox_full' }, 503);
    }
    const s = await createSandboxTenant(c.env, { name, webhookUrl, ipHash });
    const origin = new URL(c.req.url).origin;
    return c.json(
      {
        tenant_id: s.tenantId,
        sandbox: true,
        secret_key: s.secretKey,
        public_key: s.publicKey,
        webhook_secret: s.webhookSecret,
        webhook_url: s.webhookUrl,
        demo_target_address: DEMO_TARGET,
        api_url: origin,
        expires_at: new Date(s.expiresAt * 1000).toISOString(),
        note:
          'Keys and webhook secret are shown once. Sandbox payments are simulated: ' +
          'POST /api/intents/:sid/simulate or the buttons on the checkout page. ' +
          'Production = a tenant onboarded by MPT after your own Monerium KYB; swap sk_test_ for sk_.',
      },
      201,
    );
  });

  api.get('/me', async (c) => {
    const who = await sandboxSecretCaller(c.env, c.req.raw.headers);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    const row = await c.env.DB.prepare(
      `SELECT t.id, t.name, s.outbound_webhook_url, s.created_at, s.expires_at
         FROM tenants t JOIN sandbox_tenants s ON s.tenant_id = t.id WHERE t.id = ?`,
    )
      .bind(who.tenantId)
      .first<{ id: string; name: string; outbound_webhook_url: string | null; created_at: number; expires_at: number }>();
    if (!row) return c.json({ error: 'tenant_not_found' }, 404);
    return c.json({
      tenant_id: row.id,
      name: row.name,
      sandbox: true,
      webhook_url: row.outbound_webhook_url,
      created_at: new Date(row.created_at * 1000).toISOString(),
      expires_at: new Date(row.expires_at * 1000).toISOString(),
    });
  });

  api.put('/webhook', async (c) => {
    const who = await sandboxSecretCaller(c.env, c.req.raw.headers);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    const body = await jsonBody(c.req.raw);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    let webhookUrl: string | null = null;
    if (body.webhook_url !== null && body.webhook_url !== '') {
      webhookUrl = validateWebhookUrl(body.webhook_url);
      if (!webhookUrl) return c.json({ error: 'invalid_webhook_url' }, 400);
    }
    const secret = await updateSandboxWebhook(c.env, who.tenantId, {
      webhookUrl,
      rotateSecret: body.rotate_secret === true,
    });
    return c.json({ ok: true, webhook_url: webhookUrl, ...(secret ? { webhook_secret: secret } : {}) });
  });

  return api;
}

/// `POST /api/intents/:sid/simulate` — mounted into the intent API. The sid is
/// the capability (as for status): a sandbox intent has no value to protect,
/// and the checkout buttons must work without a key. Any non-sandbox intent
/// answers exactly like a missing one.
export function registerSimulateRoute(api: Hono<{ Bindings: Env }>): void {
  api.post('/:sid/simulate', async (c) => {
    if (!sandboxEnabled(c.env)) return c.json({ error: 'intent_not_found' }, 404);
    const intent = await getIntent(c.env, c.req.param('sid'));
    if (!intent || !(await isSandboxTenant(c.env, intent.tenant_id))) {
      return c.json({ error: 'intent_not_found' }, 404);
    }
    let body: Record<string, unknown> = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        const v = JSON.parse(text);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        body = v as Record<string, unknown>;
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
    }
    const outcome = (body.outcome ?? 'paid') as SimOutcome;
    if (!SIM_OUTCOMES.includes(outcome)) return c.json({ error: 'invalid_outcome', allowed: SIM_OUTCOMES }, 400);
    let requested: number | null = null;
    if (body.amount_eur !== undefined && body.amount_eur !== null && body.amount_eur !== '') {
      const n = Number(String(body.amount_eur).replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0 || n > 10_000) return c.json({ error: 'invalid_amount_eur' }, 400);
      requested = Math.round(n * 100);
    }
    const tenantId = intent.tenant_id!;
    const t = Math.floor(Date.now() / 1000);
    if ((await countRecentSimulations(c.env, tenantId, t - 86_400)) >= SIM_PER_TENANT_PER_DAY) {
      return c.json({ error: 'rate_limited', limit: SIM_PER_TENANT_PER_DAY, window: '24h' }, 429);
    }
    const r = await simulatePayment(c.env, intent, outcome, requested);
    if (!r.ok) return c.json({ error: r.error }, r.error === 'invalid_amount' ? 400 : 409);
    await touchSandboxTenant(c.env, tenantId);
    return c.json({
      ok: true,
      outcome: r.outcome,
      simulated_order_id: r.orderId,
      sid: r.intent.sid,
      state: r.intent.state,
      amount_received_cents: r.intent.amount_received_cents,
      status_url: `${new URL(c.req.url).origin}/api/intents/${r.intent.sid}`,
    });
  });
}
