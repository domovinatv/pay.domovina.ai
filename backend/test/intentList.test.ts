import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import { hashApiKey } from '../src/tenants/db';
import { decodeCursor, encodeCursor } from '../src/intents/list';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0024 D8: GET /api/intents (keyset list) and GET /api/intents/stats,
/// secret key only, always scoped to the key's tenant.

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const BASE = 'https://mpt.domovina.ai';
const SK_A = 'sk_' + 'a1'.repeat(24);
const PK_A = 'pk_' + 'a2'.repeat(24);
const SK_B = 'sk_' + 'b1'.repeat(24);
const SK_ITALK = 'sk_' + 'c1'.repeat(24);
const T = '0x1111111111111111111111111111111111111111';

async function setup() {
  const { db, raw } = migratedD1();
  for (const id of ['tenant-a', 'tenant-b']) {
    raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
                 VALUES (?, ?, 'active', '[]', ?, 'EE707777000162921128', 0, 0)`).run(id, id, id);
  }
  // Migration 0014 seeds italk; make sure it exists either way.
  raw.prepare(`INSERT OR IGNORE INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
               VALUES ('italk', 'ITalk', 'active', '[]', 'ITalk d.o.o.', 'EE707777000162921128', 0, 0)`).run();
  for (const [key, tenant, kind] of [
    [SK_A, 'tenant-a', 'secret'], [PK_A, 'tenant-a', 'public'], [SK_B, 'tenant-b', 'secret'], [SK_ITALK, 'italk', 'secret'],
  ]) {
    raw.prepare(`INSERT INTO tenant_api_keys (key_hash, tenant_id, kind, created_at) VALUES (?, ?, ?, 0)`)
      .run(await hashApiKey(key), tenant, kind);
  }
  const env = {
    DB: db, DEFAULT_TENANT_ID: 'italk', MULTI_TENANT_RAIL: '1', INTENT_REQUIRE_TENANT_KEY: '0', ALLOWED_ORIGINS: '',
    SANDBOX_SELF_SERVE: '1', TENANT_SECRETS_KEK: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
  } as unknown as Env;
  const intent = (sid: string, tenant: string | null, createdAt: number, over: Record<string, unknown> = {}) => {
    const row = {
      sid, target_address: T, amount_cents: 1000, currency: 'eur', state: 'pending',
      created_at: createdAt, expires_at: createdAt + 900, tenant_id: tenant,
      paid_at: null, monerium_order_id: null, amount_received_cents: null, metadata_json: '{"userId":"u1"}',
      ...over,
    };
    const cols = Object.keys(row);
    raw.prepare(`INSERT INTO payment_intents (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...(Object.values(row) as never[]));
  };
  return { env, raw, intent };
}

function get(env: Env, path: string, key?: string): Promise<Response> {
  const headers = key ? { authorization: `Bearer ${key}` } : undefined;
  return worker.fetch(new Request(`${BASE}${path}`, { headers }), env, ctx);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /api/intents — who may list', () => {
  it.each([
    ['no key', undefined, 401, 'missing_tenant_key'],
    ['public key', PK_A, 403, 'secret_key_required'],
    ['unknown key', 'sk_' + 'ff'.repeat(24), 401, 'invalid_tenant_key'],
  ])('%s → %i', async (_n, key, status, error) => {
    const { env } = await setup();
    for (const path of ['/api/intents', '/api/intents/stats']) {
      const res = await get(env, path, key);
      expect(res.status).toBe(status);
      expect((await json(res)).error).toBe(error);
    }
  });

  it('a tenant only ever sees its own intents', async () => {
    const { env, intent } = await setup();
    intent('aaaaaa01', 'tenant-a', 100);
    intent('bbbbbb01', 'tenant-b', 100);
    intent('legacy01', null, 100);
    const a = await json(await get(env, '/api/intents', SK_A));
    expect((a.data as Array<{ sid: string }>).map((i) => i.sid)).toEqual(['aaaaaa01']);
    const b = await json(await get(env, '/api/intents', SK_B));
    expect((b.data as Array<{ sid: string }>).map((i) => i.sid)).toEqual(['bbbbbb01']);
  });

  it('the default tenant also owns the pre-tenant rows (tenant_id NULL)', async () => {
    const { env, intent } = await setup();
    intent('italk001', 'italk', 200);
    intent('legacy01', null, 100);
    intent('aaaaaa01', 'tenant-a', 300);
    const r = await json(await get(env, '/api/intents', SK_ITALK));
    expect((r.data as Array<{ sid: string }>).map((i) => i.sid)).toEqual(['italk001', 'legacy01']);
  });
});

describe('GET /api/intents — paging and filters', () => {
  it('keyset pages cover every row exactly once, ties on created_at included', async () => {
    const { env, intent } = await setup();
    for (const [sid, at] of [['s00001', 50], ['s00002', 50], ['s00003', 50], ['s00004', 40], ['s00005', 60]] as const) {
      intent(sid, 'tenant-a', at);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await json(await get(env, `/api/intents?limit=2${cursor ? `&cursor=${cursor}` : ''}`, SK_A));
      seen.push(...(r.data as Array<{ sid: string }>).map((i) => i.sid));
      cursor = r.next_cursor as string | null;
      expect(r.has_more).toBe(cursor !== null);
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(['s00005', 's00003', 's00002', 's00001', 's00004']);
    expect(pages).toBe(3);
  });

  it('filters by state and created range', async () => {
    const { env, intent } = await setup();
    intent('paid0001', 'tenant-a', 1_000, { state: 'paid', paid_at: 1_100, amount_received_cents: 1000 });
    intent('pend0001', 'tenant-a', 2_000);
    intent('paid0002', 'tenant-a', 3_000, { state: 'paid', paid_at: 3_100, amount_received_cents: 1000 });
    const paid = await json(await get(env, '/api/intents?state=paid', SK_A));
    expect((paid.data as Array<{ sid: string }>).map((i) => i.sid)).toEqual(['paid0002', 'paid0001']);
    const from = new Date(1_500_000).toISOString();
    const to = new Date(3_000_000).toISOString();
    const ranged = await json(await get(env, `/api/intents?created_from=${from}&created_to=${to}`, SK_A));
    expect((ranged.data as Array<{ sid: string }>).map((i) => i.sid)).toEqual(['pend0001']);
  });

  it('items keep the intent shape, metadata included, without payment codes', async () => {
    const { env, intent } = await setup();
    intent('paid0001', 'tenant-a', 1_000, { state: 'paid', paid_at: 1_100, amount_received_cents: 1000 });
    const r = await json(await get(env, '/api/intents', SK_A));
    const item = (r.data as Array<Record<string, unknown>>)[0];
    expect(item).toMatchObject({
      sid: 'paid0001', state: 'paid', amount_cents: 1000, amount_eur: '10.00', tenant_id: 'tenant-a',
      metadata: { userId: 'u1' }, status_url: `${BASE}/api/intents/paid0001`,
    });
    expect(item).not.toHaveProperty('epc_qr_data');
    expect(item).not.toHaveProperty('hub3_data');
  });

  it.each([
    ['state=refunded', 'invalid_state'],
    ['limit=0', 'invalid_limit'],
    ['limit=201', 'invalid_limit'],
    ['cursor=%21%21', 'invalid_cursor'],
    ['created_from=yesterday', 'invalid_created_from'],
  ])('%s → 400 %s', async (qs, error) => {
    const { env } = await setup();
    const res = await get(env, `/api/intents?${qs}`, SK_A);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe(error);
  });

  it('cursor round-trips and rejects junk', () => {
    const c = encodeCursor({ created_at: 1791802000, sid: 'm7p27dhnvac3' });
    expect(decodeCursor(c)).toEqual({ createdAt: 1791802000, sid: 'm7p27dhnvac3' });
    expect(decodeCursor('bm9wZQ')).toBeNull();
  });
});

describe('GET /api/intents/stats', () => {
  it('sums each outcome bucket for the caller only', async () => {
    const { env, intent } = await setup();
    intent('paid0001', 'tenant-a', 10, { state: 'paid', paid_at: 20, amount_received_cents: 1000, monerium_order_id: 'o1' });
    intent('paid0002', 'tenant-a', 11, { state: 'paid', paid_at: 21, amount_cents: 500, amount_received_cents: 600, monerium_order_id: 'o2' });
    intent('late0001', 'tenant-a', 12, { state: 'expired', paid_at: 30, amount_received_cents: 1000, monerium_order_id: 'o3' });
    intent('undp0001', 'tenant-a', 13, { amount_received_cents: 900, monerium_order_id: 'o4' });
    intent('pend0001', 'tenant-a', 14);
    intent('expd0001', 'tenant-a', 15, { state: 'expired' });
    intent('paidbbbb', 'tenant-b', 10, { state: 'paid', paid_at: 20, amount_received_cents: 99999, monerium_order_id: 'o5' });
    const res = await get(env, '/api/intents/stats', SK_A);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      tenant_id: 'tenant-a', currency: 'eur', created_from: null, created_to: null,
      paid: { count: 2, amount_cents: 1500, amount_received_cents: 1600 },
      late: { count: 1, amount_cents: 1000, amount_received_cents: 1000 },
      underpaid: { count: 1, amount_cents: 1000, amount_received_cents: 900 },
      pending: { count: 1, amount_cents: 1000, amount_received_cents: 0 },
      expired: { count: 1, amount_cents: 1000, amount_received_cents: 0 },
    });
  });

  it('a sandbox tenant lists and sums its simulated payments', async () => {
    const { env } = await setup();
    const create = await worker.fetch(new Request(`${BASE}/api/sandbox/tenants`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
      body: JSON.stringify({ name: 'dev' }),
    }), env, ctx);
    const sb = (await create.json()) as Record<string, string>;
    const made = await worker.fetch(new Request(`${BASE}/api/intents`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sb.secret_key}` },
      body: JSON.stringify({ target_address: T, amount_eur: '4.20' }),
    }), env, ctx);
    const sid = ((await made.json()) as { sid: string }).sid;
    await worker.fetch(new Request(`${BASE}/api/intents/${sid}/simulate`, { method: 'POST' }), env, ctx);
    const list = await json(await get(env, '/api/intents', sb.secret_key));
    expect((list.data as Array<Record<string, unknown>>)[0]).toMatchObject({ sid, state: 'paid', sandbox: true, iban: null });
    const stats = await json(await get(env, '/api/intents/stats', sb.secret_key));
    expect(stats.paid).toEqual({ count: 1, amount_cents: 420, amount_received_cents: 420 });
  });
});
