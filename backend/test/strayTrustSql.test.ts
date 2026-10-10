import { describe, expect, it } from 'vitest';

import { findStrayCandidates, isTrustedTarget, listRerouteCandidates } from '../src/intents/db';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// SR-01 against real SQLite + every migration (incl. 0014 seed and 0022).
const LUKAVEC = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';
const WALLET = '0x95b8a4ecda0272abef219954a06566c892eeece5'; // seed 0014 "…wallet_registry"
const SELF_REG = '0x' + 'ab'.repeat(20); // only in wallet_registry

function setup() {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO tenant_payout_addresses (tenant_id, address, label, source, created_at, created_by)
               VALUES ('italk', ?, 'campaign Lukavec', 'admin', 0, 'test')`).run(LUKAVEC);
  const add = (sid: string, target: string, withKey = 0, tenant: string | null = 'italk') =>
    raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id, created_with_key)
                 VALUES (?, ?, 100, 'eur', 'pending', 1000, 1900, ?, ?)`).run(sid, target, tenant, withKey);
  const env = { DB: db } as unknown as Env;
  const args = { tenantId: 'italk', defaultTenantId: 'italk', amountCents: 100, createdFrom: 0, createdTo: 5000 };
  return { env, raw, add, args };
}

describe('stray candidate trust (SQL)', () => {
  it('migration 0022 moves the seeded wallet Safes out of trusted seed rows', () => {
    const { raw } = setup();
    const row = raw.prepare(`SELECT source FROM tenant_payout_addresses WHERE lower(address) = ?`).get(WALLET) as { source: string };
    expect(row.source).toBe('seed_wallet');
    const plainSeed = raw.prepare(`SELECT COUNT(*) AS c FROM tenant_payout_addresses WHERE source = 'seed' AND label LIKE '%wallet%'`).get() as { c: number };
    expect(plainSeed.c).toBe(0);
  });

  it('admin whitelist → trusted; seeded wallet / self-registered → not; secret-key intent → trusted', async () => {
    const { env, add, args } = setup();
    add('a-lukavec', LUKAVEC);
    add('b-wallet', WALLET);
    add('c-selfreg', SELF_REG);
    add('d-keyed', SELF_REG, 1);
    add('e-legacy-null-tenant', LUKAVEC, 0, null);
    const rows = await findStrayCandidates(env, args);
    const trust = Object.fromEntries(rows.map((r) => [r.sid, r.trusted]));
    expect(trust).toEqual({
      'a-lukavec': true,
      'b-wallet': false,
      'c-selfreg': false,
      'd-keyed': true,
      'e-legacy-null-tenant': true,
    });
  });

  it('the reroute picker carries the same flag', async () => {
    const { env, add, args } = setup();
    add('a-lukavec', LUKAVEC);
    add('b-wallet', WALLET);
    const rows = await listRerouteCandidates(env, args);
    expect(Object.fromEntries(rows.map((r) => [r.sid, r.trusted]))).toEqual({ 'a-lukavec': true, 'b-wallet': false });
  });

  it('isTrustedTarget follows the same rule', async () => {
    const { env } = setup();
    expect(await isTrustedTarget(env, 'italk', LUKAVEC.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(await isTrustedTarget(env, 'italk', WALLET)).toBe(false);
  });

  it('an underpaid (pending, order attached) intent is not a candidate', async () => {
    const { env, raw, add, args } = setup();
    add('a-lukavec', LUKAVEC);
    raw.prepare(`UPDATE payment_intents SET monerium_order_id = 'ord-1' WHERE sid = 'a-lukavec'`).run();
    expect(await findStrayCandidates(env, args)).toHaveLength(0);
  });
});

describe('POST /api/intents — SR-01 trust flag and open-intent cap', async () => {
  const { default: worker } = await import('../src/index');
  const { hashApiKey } = await import('../src/tenants/db');
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  function api() {
    const { db, raw } = migratedD1();
    raw.prepare(`INSERT INTO tenant_payout_addresses (tenant_id, address, label, source, created_at, created_by)
                 VALUES ('italk', ?, 'campaign Lukavec', 'admin', 0, 'test')`).run(LUKAVEC);
    const env = {
      DB: db,
      ALLOWED_ORIGINS: 'https://mpt.domovina.ai',
      DEFAULT_TENANT_ID: 'italk',
      INTENT_REQUIRE_TENANT_KEY: '0',
      MAX_OPEN_INTENTS_PER_TARGET: '3',
      MONERIUM_IBAN: 'EE000000000000000000',
      MONERIUM_BENEFICIARY_NAME: 'ITalk',
    } as unknown as Env;
    const post = (target: string, key?: string) =>
      worker.fetch(new Request('https://mpt.domovina.ai/api/intents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'x-mpt-key': key } : {}) },
        body: JSON.stringify({ target_address: target, amount_eur: '1.00' }),
      }), env, ctx);
    return { raw, post };
  }

  it('caps open intents on an untrusted destination, never on a trusted one', async () => {
    const { post } = api();
    for (let i = 0; i < 3; i++) expect((await post(WALLET)).status).toBe(200);
    const res = await post(WALLET);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'too_many_open_intents' });
    for (let i = 0; i < 5; i++) expect((await post(LUKAVEC)).status).toBe(200);
  });

  it('a secret key marks the intent trusted and skips the cap', async () => {
    const { raw, post } = api();
    const sk = 'sk_' + 'cd'.repeat(16);
    raw.prepare(`INSERT INTO tenant_api_keys (key_hash, tenant_id, kind, created_at) VALUES (?, 'italk', 'secret', 0)`)
      .run(await hashApiKey(sk));
    for (let i = 0; i < 4; i++) expect((await post(WALLET, sk)).status).toBe(200);
    const flags = raw.prepare(`SELECT DISTINCT created_with_key AS k FROM payment_intents`).all() as Array<{ k: number }>;
    expect(flags).toEqual([{ k: 1 }]);
  });

  it('no key → not trusted', async () => {
    const { raw, post } = api();
    expect((await post(LUKAVEC)).status).toBe(200);
    expect((raw.prepare(`SELECT created_with_key AS k FROM payment_intents`).get() as { k: number }).k).toBe(0);
  });
});
