import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { SANDBOX_FUND_URL } from '../src/monerium/client';
import { encryptSecret, importKek } from '../src/tenants/secrets';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// "Simuliraj SEPA uplatu" on the checkout of a rail tenant on Monerium's
/// sandbox: the rail asks Monerium to fake the bank leg with the intent's
/// amount and reference; nothing else is simulated.

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const SAFE_MAIN = '0x47b385898b0218402fe7a0d4400ea0bbae81923e';
const PROJECT = '0xabc3000000000000000000000000000000ef8e00';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const BASE = 'https://mpt.domovina.ai';

function kv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
  };
}

async function setup(fundStatus = 201) {
  const { db, raw } = migratedD1();
  const kek = await importKek(KEK);
  for (const [id, moneriumEnv] of [['sbx-rail', 'sandbox'], ['live-rail', 'production']] as const) {
    raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
                 VALUES (?, ?, 'active', '[]', ?, 'EE11 7863 3891 6150 7282', 0, 0)`).run(id, id, id);
    raw.prepare(`INSERT INTO tenant_rail (tenant_id, monerium_env, chain, client_id, client_secret_enc, profile_id,
                   receiving_safe, eure_contract, mode, created_at, updated_at)
                 VALUES (?, ?, 'chiado', 'cid', ?, ?, ?, ?, 'direct', 0, 0)`)
      .run(id, moneriumEnv, await encryptSecret(kek, id, 'client_secret', 'cs'), `prof-${id}`, SAFE_MAIN, '0x' + '11'.repeat(20));
  }
  const t = Math.floor(Date.now() / 1000);
  for (const [sid, tenant, state] of [
    ['simsid000001', 'sbx-rail', 'pending'],
    ['simsid000002', 'live-rail', 'pending'],
    ['simsid000003', 'sbx-rail', 'paid'],
  ]) {
    raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id)
                 VALUES (?, ?, 1000, 'EUR', ?, ?, ?, ?)`).run(sid, PROJECT, state, t, t + 900, tenant);
  }
  const env = {
    DB: db, TOKEN_CACHE: kv(), DEFAULT_TENANT_ID: 'italk', MULTI_TENANT_RAIL: '1', TENANT_SECRETS_KEK: KEK,
    INTENT_REQUIRE_TENANT_KEY: '0', ALLOWED_ORIGINS: '',
  } as unknown as Env;
  const funded: Array<{ auth: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/auth/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (url === SANDBOX_FUND_URL) {
      funded.push({
        auth: (init.headers as Record<string, string>).Authorization,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return new Response('{}', { status: fundStatus });
    }
    return new Response('unexpected', { status: 500 });
  }));
  return { env, funded };
}

afterEach(() => vi.unstubAllGlobals());

const transfer = (env: Env, sid: string) =>
  worker.fetch(new Request(`${BASE}/api/intents/${sid}/monerium-sandbox-transfer`, { method: 'POST' }), env, ctx);

describe('POST /api/intents/:sid/monerium-sandbox-transfer', () => {
  it('funds the tenant IBAN with the intent amount and its reference as memo', async () => {
    const { env, funded } = await setup();
    const r = await transfer(env, 'simsid000001');
    expect(r.status).toBe(200);
    expect(funded).toHaveLength(1);
    expect(funded[0].auth).toBe('Bearer tok');
    expect(funded[0].body).toMatchObject({
      currency: 'EUR',
      amount: '10.00',
      iban: 'EE117863389161507282',
      memo: `chiado:${PROJECT} sid:simsid000001`,
    });
  });

  it('a second click within a minute does not fund twice', async () => {
    const { env, funded } = await setup();
    expect((await transfer(env, 'simsid000001')).status).toBe(200);
    expect((await transfer(env, 'simsid000001')).status).toBe(429);
    expect(funded).toHaveLength(1);
  });

  it('a production rail answers like a missing intent and calls nothing', async () => {
    const { env, funded } = await setup();
    expect((await transfer(env, 'simsid000002')).status).toBe(404);
    expect(funded).toHaveLength(0);
  });

  it('refuses an intent that is no longer pending', async () => {
    const { env, funded } = await setup();
    expect((await transfer(env, 'simsid000003')).status).toBe(409);
    expect(funded).toHaveLength(0);
  });

  it('a Monerium error is 502 and frees the lock for a retry', async () => {
    const { env, funded } = await setup(400);
    expect((await transfer(env, 'simsid000001')).status).toBe(502);
    expect((await transfer(env, 'simsid000001')).status).toBe(502);
    expect(funded).toHaveLength(2);
  });
});

describe('checkout page', () => {
  it('shows the button only to a Monerium-sandbox rail tenant, next to the real IBAN', async () => {
    const { env } = await setup();
    const sbx = await (await worker.fetch(new Request(`${BASE}/checkout/simsid000001`), env, ctx)).text();
    expect(sbx).toContain('onclick="simulateSepa()"');
    expect(sbx).toContain('MONERIUM SANDBOX');
    expect(sbx).toContain('EE11 7863 3891 6150 7282');
    const live = await (await worker.fetch(new Request(`${BASE}/checkout/simsid000002`), env, ctx)).text();
    expect(live).not.toContain('onclick="simulateSepa()"');
    expect(live).not.toContain('MONERIUM SANDBOX');
  });
});
