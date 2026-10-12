import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { hashApiKey } from '../src/tenants/db';
import { resolveRequestTenant } from '../src/tenants/auth';
import { validateReturnUrl } from '../src/intents/api';
import { returnHref } from '../src/checkout/page';
import { attemptDelivery, type OutboxDeps, type OutboxRow } from '../src/intents/outbox';
import { sweepExpiredSandboxTenants } from '../src/sandbox/db';
import { SIM_PAYER_IBAN, simulatedAmountCents } from '../src/sandbox/simulate';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0024: self-serve sandbox tenants with simulated payments, and
/// return_url on intents. End to end over a real SQLite D1.

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const HOOK = 'https://app.example/payments-webhook';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const BASE = 'https://mpt.domovina.ai';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  raw: string;
}

function setup(over: Partial<Env> = {}) {
  const { db, raw } = migratedD1();
  const env = {
    DB: db,
    DEFAULT_TENANT_ID: 'italk',
    MULTI_TENANT_RAIL: '1',
    TENANT_SECRETS_KEK: KEK,
    INTENT_REQUIRE_TENANT_KEY: '0',
    ALLOWED_ORIGINS: '',
    SANDBOX_SELF_SERVE: '1',
    SANDBOX_IP_PEPPER: 'pepper',
    ...over,
  } as unknown as Env;
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const rawBody = String(init.body);
    sent.push({
      url,
      headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>)),
      body: JSON.parse(rawBody) as Record<string, unknown>,
      raw: rawBody,
    });
    return new Response('ok', { status: 200 });
  }));
  return { env, raw, sent };
}

afterEach(() => vi.unstubAllGlobals());

function call(env: Env, path: string, init: RequestInit & { ip?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('cf-connecting-ip', init.ip ?? '203.0.113.7');
  return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }), env, ctx);
}

async function newSandbox(env: Env, body: Record<string, unknown> = { name: 'Open SaaS dev', webhook_url: HOOK }, ip?: string) {
  const res = await call(env, '/api/sandbox/tenants', { method: 'POST', body: JSON.stringify(body), ip });
  return { res, j: (await res.json()) as Record<string, string> };
}

async function newIntent(env: Env, key: string, extra: Record<string, unknown> = {}) {
  const res = await call(env, '/api/intents', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify({
      target_address: '0x1111111111111111111111111111111111111111',
      amount_eur: '9.90',
      label: 'Credits',
      metadata: { userId: 'u1', paymentPlanId: 'credits10' },
      ...extra,
    }),
  });
  return { res, j: (await res.json()) as Record<string, unknown> };
}

async function simulate(env: Env, sid: string, body: Record<string, unknown> = {}) {
  const res = await call(env, `/api/intents/${sid}/simulate`, { method: 'POST', body: JSON.stringify(body) });
  return { res, j: (await res.json()) as Record<string, unknown> };
}

async function verifySignature(secret: string, s: Sent): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw', Uint8Array.from(atob(secret.slice('whsec_'.length)), (ch) => ch.charCodeAt(0)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${s.headers['webhook-id']}.${s.headers['webhook-timestamp']}.${s.raw}`),
  );
  return s.headers['webhook-signature'] === `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

describe('POST /api/sandbox/tenants', () => {
  it('is 404 unless SANDBOX_SELF_SERVE=1', async () => {
    const { env } = setup({ SANDBOX_SELF_SERVE: '0' });
    expect((await newSandbox(env)).res.status).toBe(404);
  });

  it('creates a sandbox tenant with test keys, a whsec_ secret and no rail', async () => {
    const { env, raw } = setup();
    const { res, j } = await newSandbox(env);
    expect(res.status).toBe(201);
    expect(j.tenant_id).toMatch(/^sbx-[0-9a-f]{10}$/);
    expect(j.secret_key).toMatch(/^sk_test_[0-9a-f]{48}$/);
    expect(j.public_key).toMatch(/^pk_test_[0-9a-f]{48}$/);
    expect(j.webhook_secret).toMatch(/^whsec_/);
    expect(j.webhook_url).toBe(HOOK);
    const t = raw.prepare(`SELECT status, sandbox FROM tenants WHERE id = ?`).get(j.tenant_id) as Record<string, unknown>;
    expect(t).toEqual({ status: 'active', sandbox: 1 });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM tenant_rail WHERE tenant_id = ?`).get(j.tenant_id)).toEqual({ n: 0 });
    // Neither the secret nor the IP is stored in clear.
    const s = raw.prepare(`SELECT * FROM sandbox_tenants WHERE tenant_id = ?`).get(j.tenant_id) as Record<string, string>;
    expect(s.outbound_webhook_secret_enc).not.toContain(j.webhook_secret);
    expect(s.created_ip_hash).not.toContain('203.0.113.7');
  });

  it.each([
    ['http webhook', { name: 'x', webhook_url: 'http://app.example/hook' }, 'invalid_webhook_url'],
    ['credentials in webhook', { name: 'x', webhook_url: 'https://u:p@app.example/hook' }, 'invalid_webhook_url'],
    ['no name', { webhook_url: HOOK }, 'invalid_name'],
  ])('%s → 400', async (_n, body, error) => {
    const { env } = setup();
    const { res, j } = await newSandbox(env, body);
    expect(res.status).toBe(400);
    expect(j.error).toBe(error);
  });

  it('limits one IP to 5 tenants per 24 h', async () => {
    const { env } = setup();
    for (let i = 0; i < 5; i++) expect((await newSandbox(env)).res.status).toBe(201);
    const sixth = await newSandbox(env);
    expect(sixth.res.status).toBe(429);
    expect((await newSandbox(env, { name: 'other' }, '198.51.100.1')).res.status).toBe(201);
  });

  it('refuses beyond SANDBOX_MAX_TENANTS', async () => {
    const { env } = setup({ SANDBOX_MAX_TENANTS: '1' });
    expect((await newSandbox(env)).res.status).toBe(201);
    const { res, j } = await newSandbox(env, { name: 'x' }, '198.51.100.2');
    expect(res.status).toBe(503);
    expect(j.error).toBe('sandbox_full');
  });

  it('requires a Turnstile token once SANDBOX_TURNSTILE_SECRET is set', async () => {
    const { env } = setup({ SANDBOX_TURNSTILE_SECRET: 'ts' });
    const { res, j } = await newSandbox(env);
    expect(res.status).toBe(403);
    expect(j.error).toBe('turnstile_failed');
  });
});

describe('test keys vs live keys (ADR 0024 D2)', () => {
  it('a test key never names a live tenant, a live key never a sandbox tenant', async () => {
    const { env, raw } = setup();
    const { j } = await newSandbox(env);
    raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
                 VALUES ('live', 'Live', 'active', '[]', 'Live d.o.o.', 'EE707777000162921128', 0, 0)`).run();
    const liveAsTest = 'sk_test_' + 'ab'.repeat(24);
    const sandboxAsLive = 'sk_' + 'cd'.repeat(24);
    raw.prepare(`INSERT INTO tenant_api_keys (key_hash, tenant_id, kind, created_at) VALUES (?, 'live', 'secret', 0)`)
      .run(await hashApiKey(liveAsTest));
    raw.prepare(`INSERT INTO tenant_api_keys (key_hash, tenant_id, kind, created_at) VALUES (?, ?, 'secret', 0)`)
      .run(await hashApiKey(sandboxAsLive), j.tenant_id);
    for (const key of [liveAsTest, sandboxAsLive]) {
      const r = await resolveRequestTenant(env, new Headers({ authorization: `Bearer ${key}` }));
      expect(r).toEqual({ ok: false, error: 'invalid_tenant_key' });
    }
    const ok = await resolveRequestTenant(env, new Headers({ authorization: `Bearer ${j.secret_key}` }));
    expect(ok).toEqual({ ok: true, tenantId: j.tenant_id, keyKind: 'secret', sandbox: true });
  });
});

describe('sandbox intents (ADR 0024 D5)', () => {
  it('any target, no IBAN/QR, simulate_url, and a sandbox checkout', async () => {
    const { env } = setup();
    const { j: sb } = await newSandbox(env);
    const { res, j } = await newIntent(env, sb.secret_key);
    expect(res.status).toBe(200);
    expect(j).toMatchObject({
      sandbox: true, iban: null, epc_qr_data: null, hub3_data: null, beneficiary_name: null,
      tenant_id: sb.tenant_id, amount_eur: '9.90', state: 'pending',
    });
    expect(j.simulate_url).toBe(`${BASE}/api/intents/${j.sid}/simulate`);
    expect(j.checkout_url).toBe(`${BASE}/checkout/${j.sid}`);
    const again = (await (await call(env, `/api/intents/${j.sid}`)).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ sandbox: true, iban: null, epc_qr_data: null });
    const page = await (await call(env, `/checkout/${j.sid}`)).text();
    expect(page).toContain('SANDBOX');
    expect(page).toContain("simulate('paid')");
    expect(page).not.toContain('XX00');
    expect(page).not.toContain('id="qrBox"><svg');
  });

  it('refuses receipt sids (receipts are anchored on-chain)', async () => {
    const { env } = setup();
    const { j: sb } = await newSandbox(env);
    const { res, j } = await newIntent(env, sb.secret_key, { sid: 'r1' + 'a'.repeat(24) });
    expect(res.status).toBe(400);
    expect(j.error).toBe('receipts_not_in_sandbox');
  });
});

describe('simulated payments (ADR 0024 D4)', () => {
  it('paid: payment.received then intent.paid, signed with the tenant secret; status settled', async () => {
    const { env, raw, sent } = setup();
    const { j: sb } = await newSandbox(env);
    const { j: intent } = await newIntent(env, sb.secret_key);
    const sid = intent.sid as string;
    const { res, j } = await simulate(env, sid);
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: true, outcome: 'paid', state: 'paid', amount_received_cents: 990 });
    expect(sent.map((s) => s.body.type)).toEqual(['payment.received', 'intent.paid']);
    expect(sent.every((s) => s.url === HOOK)).toBe(true);
    for (const s of sent) expect(await verifySignature(sb.webhook_secret, s)).toBe(true);
    expect(sent[1].body).toMatchObject({
      sid, state: 'paid', amount_cents: 990, sender_iban: SIM_PAYER_IBAN,
      metadata: { userId: 'u1', paymentPlanId: 'credits10' },
    });
    expect(sent[1].headers['webhook-id']).toBe(`int_${sid}`);
    const status = (await (await call(env, `/api/intents/${sid}`)).json()) as { state: string; status: { stage: string } };
    expect(status.state).toBe('paid');
    expect(status.status.stage).toBe('settled');
    const fwd = raw.prepare(`SELECT status, error, tx_hash, tenant_id FROM monerium_forwards WHERE sid = ?`).get(sid);
    expect(fwd).toEqual({ status: 'confirmed', error: 'simulated', tx_hash: null, tenant_id: sb.tenant_id });
    // Once is enough.
    expect((await simulate(env, sid)).res.status).toBe(409);
  });

  it('received, then paid: one order, payment.received once', async () => {
    const { env, raw, sent } = setup();
    const { j: sb } = await newSandbox(env);
    const sid = (await newIntent(env, sb.secret_key)).j.sid as string;
    await simulate(env, sid, { outcome: 'received' });
    const mid = (await (await call(env, `/api/intents/${sid}`)).json()) as { status: { stage: string } };
    expect(mid.status.stage).toBe('received_processing');
    await simulate(env, sid, { outcome: 'paid' });
    expect(sent.map((s) => s.body.type)).toEqual(['payment.received', 'intent.paid']);
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM monerium_orders WHERE tenant_id = ?`).get(sb.tenant_id)).toEqual({ n: 1 });
  });

  it.each([
    ['underpaid', 'payment.underpaid', 'pending'],
    ['late', 'payment.late', 'expired'],
    ['rejected', 'payment.rejected', 'pending'],
  ])('%s → %s, intent %s', async (outcome, event, state) => {
    const { env, sent } = setup();
    const { j: sb } = await newSandbox(env);
    const sid = (await newIntent(env, sb.secret_key)).j.sid as string;
    const { res, j } = await simulate(env, sid, { outcome });
    expect(res.status).toBe(200);
    expect(j.state).toBe(state);
    expect(sent.map((s) => s.body.type)).toEqual(['payment.received', event]);
    if (outcome === 'rejected') {
      const st = (await (await call(env, `/api/intents/${sid}`)).json()) as { status: { stage: string } };
      expect(st.status.stage).toBe('rejected');
    }
  });

  it('a live tenant’s intent cannot be simulated (answers like a missing one)', async () => {
    const { env } = setup();
    const res = await call(env, '/api/intents', {
      method: 'POST',
      body: JSON.stringify({ target_address: '0x1111111111111111111111111111111111111111', amount_eur: '1' }),
    });
    const sid = ((await res.json()) as { sid?: string }).sid ?? 'nosuchsid1';
    const r = await simulate(env, sid);
    expect(r.res.status).toBe(404);
    expect(r.j.error).toBe('intent_not_found');
  });

  it('no webhook URL: simulation still settles, nothing is sent', async () => {
    const { env, sent } = setup();
    const { j: sb } = await newSandbox(env, { name: 'no hook' });
    const sid = (await newIntent(env, sb.secret_key)).j.sid as string;
    expect((await simulate(env, sid)).j.state).toBe('paid');
    expect(sent).toEqual([]);
  });

  it('underpaid amount defaults to 1 € short', () => {
    expect(simulatedAmountCents(990, 'underpaid', null)).toBe(890);
    expect(simulatedAmountCents(150, 'underpaid', null)).toBe(75);
    expect(simulatedAmountCents(990, 'paid', null)).toBe(990);
    expect(simulatedAmountCents(990, 'paid', 1200)).toBe(1200);
  });
});

describe('sandbox webhook management', () => {
  it('PUT /api/sandbox/webhook needs the sk_test_ key and can rotate the secret', async () => {
    const { env, sent } = setup();
    const { j: sb } = await newSandbox(env, { name: 'x' });
    const pk = await call(env, '/api/sandbox/webhook', {
      method: 'PUT', headers: { authorization: `Bearer ${sb.public_key}` }, body: JSON.stringify({ webhook_url: HOOK }),
    });
    expect(pk.status).toBe(403);
    const res = await call(env, '/api/sandbox/webhook', {
      method: 'PUT', headers: { authorization: `Bearer ${sb.secret_key}` },
      body: JSON.stringify({ webhook_url: HOOK, rotate_secret: true }),
    });
    const j = (await res.json()) as Record<string, string>;
    expect(res.status).toBe(200);
    expect(j.webhook_secret).toMatch(/^whsec_/);
    expect(j.webhook_secret).not.toBe(sb.webhook_secret);
    const sid = (await newIntent(env, sb.secret_key)).j.sid as string;
    await simulate(env, sid);
    expect(sent).toHaveLength(2);
    expect(await verifySignature(j.webhook_secret, sent[1])).toBe(true);
    const me = (await (await call(env, '/api/sandbox/me', { headers: { authorization: `Bearer ${sb.secret_key}` } })).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ tenant_id: sb.tenant_id, sandbox: true, webhook_url: HOOK });
  });

  it('a failed delivery to a sandbox endpoint never pages the operator', async () => {
    const alerts: string[] = [];
    const deps = {
      send: async () => ({ status: 400, error: 'bad' }),
      markFailed: async () => {},
      markRetry: async () => {},
      markDelivered: async () => {},
      alert: async (t: string) => { alerts.push(t); },
      quiet: async (tenantId: string | null) => tenantId === 'sbx-0000000000',
    } as unknown as OutboxDeps;
    const row = { id: 'int_x', type: 'intent.paid', payload: '{}', tenant_id: 'sbx-0000000000', attempts: 0 } as OutboxRow;
    expect(await attemptDelivery(deps, row, 0)).toBe('failed');
    expect(alerts).toEqual([]);
    expect(await attemptDelivery(deps, { ...row, tenant_id: 'live' }, 0)).toBe('failed');
    expect(alerts).toHaveLength(1);
  });
});

describe('return_url (ADR 0024 D6)', () => {
  it('needs a secret key', async () => {
    const { env } = setup();
    const { j: sb } = await newSandbox(env);
    const { res, j } = await newIntent(env, sb.public_key, { return_url: 'https://app.example/checkout' });
    expect(res.status).toBe(400);
    expect(j.error).toBe('return_url_requires_secret_key');
    const keyless = await call(env, '/api/intents', {
      method: 'POST',
      body: JSON.stringify({
        target_address: '0x1111111111111111111111111111111111111111', amount_eur: '1',
        return_url: 'https://evil.example/',
      }),
    });
    expect(keyless.status).toBe(400);
  });

  it('is stored, returned and rendered with mpt_sid + mpt_status', async () => {
    const { env } = setup();
    const { j: sb } = await newSandbox(env);
    const { res, j } = await newIntent(env, sb.secret_key, { return_url: 'http://localhost:3000/checkout?plan=credits10' });
    expect(res.status).toBe(200);
    expect(j.return_url).toBe('http://localhost:3000/checkout?plan=credits10');
    const page = await (await call(env, `/checkout/${j.sid}`)).text();
    expect(page).toContain(`http://localhost:3000/checkout?plan=credits10&amp;mpt_sid=${j.sid}&amp;mpt_status=cancelled`);
    expect(page).toContain('id="returnBtn"');
  });

  it.each([
    ['https://app.example/checkout', false, 'https://app.example/checkout'],
    ['http://localhost:3000/checkout', true, 'http://localhost:3000/checkout'],
    ['http://127.0.0.1:3000/x', true, 'http://127.0.0.1:3000/x'],
    ['http://localhost:3000/checkout', false, null],
    ['http://app.example/checkout', true, null],
    ['javascript:alert(1)', true, null],
    ['https://u:p@app.example/', false, null],
    ['https://app.example/#frag', false, null],
    ['/relative', false, null],
    ['https://app.example/' + 'a'.repeat(2048), false, null],
  ])('validateReturnUrl(%s, sandbox=%s) → %s', (url, sandbox, want) => {
    expect(validateReturnUrl(url, sandbox)).toBe(want);
  });

  it('returnHref keeps existing query parameters', () => {
    expect(returnHref('https://app.example/c?x=1', 'abc', 'paid')).toBe('https://app.example/c?x=1&mpt_sid=abc&mpt_status=paid');
  });
});

describe('expiry sweep', () => {
  it('removes an expired sandbox tenant with everything it owns, and nothing else', async () => {
    const { env, raw } = setup();
    const { j: sb } = await newSandbox(env);
    const sid = (await newIntent(env, sb.secret_key)).j.sid as string;
    await simulate(env, sid);
    raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
                 VALUES ('live', 'Live', 'active', '[]', 'Live', 'EE707777000162921128', 0, 0)`).run();
    raw.prepare(`UPDATE sandbox_tenants SET expires_at = 1 WHERE tenant_id = ?`).run(sb.tenant_id);
    expect(await sweepExpiredSandboxTenants(env)).toBe(1);
    for (const [table, col] of [
      ['tenants', 'id'], ['sandbox_tenants', 'tenant_id'], ['payment_intents', 'tenant_id'],
      ['monerium_orders', 'tenant_id'], ['monerium_forwards', 'tenant_id'], ['tenant_api_keys', 'tenant_id'],
      ['webhook_outbox', 'tenant_id'],
    ]) {
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(sb.tenant_id)).toEqual({ n: 0 });
    }
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM tenants WHERE id = 'live'`).get()).toEqual({ n: 1 });
  });
});
