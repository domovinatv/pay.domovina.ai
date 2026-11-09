import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { linkBases, publicApiBase } from '../src/hosts';
import { webhookUrlFor } from '../src/tenants/onboarding';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0021: api.mpt.hr + /v1, pay.mpt.hr, legacy hostovi kao trajni alias.

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const TARGET = '0x1111111111111111111111111111111111111111';

function setup(over: Partial<Env> = {}): Env {
  const { db } = migratedD1();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
  return {
    DB: db,
    DEFAULT_TENANT_ID: 'italk',
    MULTI_TENANT_RAIL: '1',
    TENANT_SECRETS_KEK: KEK,
    INTENT_REQUIRE_TENANT_KEY: '0',
    ALLOWED_ORIGINS: '',
    SANDBOX_SELF_SERVE: '1',
    SANDBOX_IP_PEPPER: 'pepper',
    ADMIN_HOST: 'mpt.domovina.ai',
    PUBLIC_API_BASE: 'https://api.mpt.hr',
    PUBLIC_CHECKOUT_BASE: 'https://pay.mpt.hr',
    ...over,
  } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

function call(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('cf-connecting-ip', '203.0.113.9');
  return worker.fetch(new Request(url, { ...init, headers, redirect: 'manual' }), env, ctx);
}

async function sandboxKey(env: Env): Promise<string> {
  const res = await call(env, 'https://mpt.domovina.ai/api/sandbox/tenants', {
    method: 'POST',
    body: JSON.stringify({ name: 'hosts test' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { secret_key: string }).secret_key;
}

async function createIntent(env: Env, key: string, url: string) {
  const res = await call(env, url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: JSON.stringify({ target_address: TARGET, amount_eur: '1.00' }),
  });
  return { res, j: (await res.json()) as Record<string, string> };
}

describe('/v1/intents na api.mpt.hr (P2, P3)', () => {
  it('kreira intent; status linkovi na /v1, checkout na pay.mpt.hr', async () => {
    const env = setup();
    const key = await sandboxKey(env);
    const { res, j } = await createIntent(env, key, 'https://api.mpt.hr/v1/intents');
    expect(res.status).toBe(200);
    expect(j.status_url).toBe(`https://api.mpt.hr/v1/intents/${j.sid}`);
    expect(j.status_stream_url).toBe(`https://api.mpt.hr/v1/intents/${j.sid}/stream`);
    expect(j.checkout_url).toBe(`https://pay.mpt.hr/checkout/${j.sid}`);
    expect(j.simulate_url).toBe(`https://api.mpt.hr/v1/intents/${j.sid}/simulate`);

    const status = await call(env, `https://api.mpt.hr/v1/intents/${j.sid}`);
    expect(status.status).toBe(200);
    expect(((await status.json()) as Record<string, string>).status_url).toBe(j.status_url);
  });

  it('/api/intents na api.mpt.hr: /api linkovi, checkout na pay.mpt.hr', async () => {
    const env = setup();
    const key = await sandboxKey(env);
    const { j } = await createIntent(env, key, 'https://api.mpt.hr/api/intents');
    expect(j.status_url).toBe(`https://api.mpt.hr/api/intents/${j.sid}`);
    expect(j.checkout_url).toBe(`https://pay.mpt.hr/checkout/${j.sid}`);
  });

  it('bez PUBLIC_CHECKOUT_BASE checkout ostaje na hostu zahtjeva', async () => {
    const env = setup({ PUBLIC_CHECKOUT_BASE: undefined });
    const key = await sandboxKey(env);
    const { j } = await createIntent(env, key, 'https://api.mpt.hr/v1/intents');
    expect(j.checkout_url).toBe(`https://api.mpt.hr/checkout/${j.sid}`);
  });

  it('nepostojeća /v1 putanja je JSON 404 i ne pada na /api', async () => {
    const env = setup();
    const res = await call(env, 'https://api.mpt.hr/v1/sandbox/tenants', { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('legacy hostovi ostaju kao prije (P1, P3)', () => {
  it('mpt.domovina.ai/api/intents: svi linkovi na istom hostu, PUBLIC_CHECKOUT_BASE se ignorira', async () => {
    const env = setup();
    const key = await sandboxKey(env);
    const { res, j } = await createIntent(env, key, 'https://mpt.domovina.ai/api/intents');
    expect(res.status).toBe(200);
    expect(j.checkout_url).toBe(`https://mpt.domovina.ai/checkout/${j.sid}`);
    expect(j.status_url).toBe(`https://mpt.domovina.ai/api/intents/${j.sid}`);
    expect(j.status_stream_url).toBe(`https://mpt.domovina.ai/api/intents/${j.sid}/stream`);
    expect(j.simulate_url).toBe(`https://mpt.domovina.ai/api/intents/${j.sid}/simulate`);
  });

  it.each(['https://mpt.domovina.ai', 'https://monerium.domovina.ai', 'http://localhost:8787'])(
    '%s ne ograničava putanje',
    async (origin) => {
      const env = setup();
      expect((await call(env, `${origin}/checkout/nepostoji`)).status).toBe(404); // intent not found, ne wrong_host
      expect(await (await call(env, `${origin}/checkout/nepostoji`)).text()).toBe('intent not found');
      expect((await call(env, `${origin}/`)).status).toBe(200);
    },
  );
});

describe('ograničenje po hostu (P4)', () => {
  const cases: Array<[string, string, string, number | 'pass']> = [
    ['api.mpt.hr', 'GET', '/', 'pass'],
    ['api.mpt.hr', 'GET', '/checkout/abc', 404],
    ['api.mpt.hr', 'GET', '/potvrda/abc', 404],
    ['api.mpt.hr', 'GET', '/api/intents/abc', 'pass'],
    ['pay.mpt.hr', 'GET', '/checkout/abc', 'pass'],
    ['pay.mpt.hr', 'GET', '/potvrda/abc', 'pass'],
    ['pay.mpt.hr', 'GET', '/api/intents/abc', 'pass'],
    ['pay.mpt.hr', 'GET', '/api/intents/abc/stream', 'pass'],
    ['pay.mpt.hr', 'POST', '/api/intents', 404],
    ['pay.mpt.hr', 'GET', '/api/hpb/accounts', 404],
    ['pay.mpt.hr', 'GET', '/api/monerium/orders', 404],
    ['pay.mpt.hr', 'POST', '/api/monerium/webhook/t/italk', 404],
    ['pay.mpt.hr', 'GET', '/api/wallets/0xabc', 404],
  ];
  it.each(cases)('%s %s %s → %s', async (host, method, path, expected) => {
    const env = setup();
    const res = await call(env, `https://${host}${path}`, { method, body: method === 'POST' ? '{}' : undefined });
    if (expected === 'pass') {
      const body = await res.clone().text();
      expect(body).not.toContain('wrong_host');
    } else {
      expect(res.status).toBe(expected);
      expect(((await res.json()) as { error: string }).error).toBe('wrong_host');
    }
  });

  it('pay.mpt.hr/admin GET preusmjerava na ADMIN_HOST, ne vraća wrong_host', async () => {
    const env = setup();
    const res = await call(env, 'https://pay.mpt.hr/admin/tenants');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://mpt.domovina.ai/admin/tenants');
  });
});

describe('PUBLIC_API_BASE za Monerium webhook (P6)', () => {
  it('koristi PUBLIC_API_BASE, a bez njega origin zahtjeva', () => {
    expect(webhookUrlFor(publicApiBase({ PUBLIC_API_BASE: 'https://api.mpt.hr/' }, 'https://dashboard.mpt.hr'), 't1'))
      .toBe('https://api.mpt.hr/api/monerium/webhook/t/t1');
    expect(webhookUrlFor(publicApiBase({}, 'https://mpt.domovina.ai'), 't1'))
      .toBe('https://mpt.domovina.ai/api/monerium/webhook/t/t1');
  });

  it('linkBases: PUBLIC_CHECKOUT_BASE samo na novim hostovima', () => {
    const env = { PUBLIC_CHECKOUT_BASE: 'https://pay.mpt.hr' };
    expect(linkBases(env, 'https://api.mpt.hr/v1/intents')).toEqual({ api: 'https://api.mpt.hr/v1', checkout: 'https://pay.mpt.hr' });
    expect(linkBases(env, 'https://mpt.domovina.ai/api/intents')).toEqual({ api: 'https://mpt.domovina.ai/api', checkout: 'https://mpt.domovina.ai' });
    expect(linkBases(env, 'http://localhost:8787/v1/intents')).toEqual({ api: 'http://localhost:8787/v1', checkout: 'http://localhost:8787' });
  });
});
