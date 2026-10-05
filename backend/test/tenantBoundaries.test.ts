import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { readTenantKey, resolveRequestTenant } from '../src/tenants/auth';
import { hashApiKey } from '../src/tenants/db';
import { enqueueWebhook } from '../src/intents/outbox';
import { notifyOrderLifecycle } from '../src/intents/lifecycle';
import { loadStageContext } from '../src/intents/stage';
import type { PaymentIntentRow } from '../src/intents/db';
import type { MoneriumOrder } from '../src/monerium/types';
import type { Env } from '../src/types';

/// ADR 0017 boundaries outside the forward itself: which tenant a request
/// names, where a tenant's events go, and whose order may move an intent.

interface Fake {
  sql: string[];
  rows: Record<string, unknown>;
}

/// D1 stand-in: the first query whose SQL contains a key of `rows` returns
/// that value from .first(); every statement is logged.
function fakeD1(f: Fake): D1Database {
  const exec = (sql: string) => ({
    first: async () => {
      for (const [k, v] of Object.entries(f.rows)) if (sql.includes(k)) return v;
      return null;
    },
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 1, last_row_id: 1 } }),
  });
  return {
    prepare: (sql: string) => {
      f.sql.push(sql);
      return { bind: () => exec(sql), ...exec(sql) };
    },
  } as unknown as D1Database;
}

function env(f: Fake, over: Partial<Env> = {}): Env {
  return {
    DB: fakeD1(f),
    ALLOWED_ORIGINS: 'https://solardei.hr',
    DEFAULT_TENANT_ID: 'italk',
    MULTI_TENANT_RAIL: '1',
    INTENT_REQUIRE_TENANT_KEY: '0',
    INTENT_WEBHOOK_URL: 'https://pinka.example/hook',
    INTENT_WEBHOOK_SECRET: 'whsec_' + btoa('pinka-secret-pinka-secret-pinka!'),
    ...over,
  } as unknown as Env;
}

afterEach(() => vi.unstubAllGlobals());

describe('tenant key: no silent fallback to the default tenant', () => {
  it('reads every present key header, even a malformed one', () => {
    expect(readTenantKey(new Headers())).toBeNull();
    expect(readTenantKey(new Headers({ authorization: 'Bearer pk_abc' }))).toBe('pk_abc');
    expect(readTenantKey(new Headers({ authorization: 'Bearer garbage' }))).toBe('garbage');
    expect(readTenantKey(new Headers({ authorization: 'Basic dXNlcjpwYXNz' }))).toBe('Basic dXNlcjpwYXNz');
    expect(readTenantKey(new Headers({ 'x-mpt-key': '' }))).toBe('');
  });

  it.each([
    ['Bearer with a non-key value', { authorization: 'Bearer undefined' }],
    ['empty Bearer', { authorization: 'Bearer ' }],
    ['empty x-mpt-key', { 'x-mpt-key': '' }],
    ['unknown pk_ key', { authorization: 'Bearer pk_0123456789abcdef0123' }],
  ])('%s → invalid_tenant_key', async (_n, headers) => {
    const f: Fake = { sql: [], rows: {} };
    const r = await resolveRequestTenant(env(f), new Headers(headers as Record<string, string>));
    expect(r).toEqual({ ok: false, error: 'invalid_tenant_key' });
  });

  it('no key at all stays on the default tenant in soft mode (unchanged)', async () => {
    const r = await resolveRequestTenant(env({ sql: [], rows: {} }), new Headers());
    expect(r).toEqual({ ok: true, tenantId: 'italk', keyKind: null });
  });
});

describe('POST /api/intents for a non-default tenant', () => {
  async function create(over: Partial<Env>, rows: Record<string, unknown> = {}): Promise<Response> {
    const key = 'pk_' + 'ab'.repeat(24);
    const f: Fake = {
      sql: [],
      rows: {
        'FROM tenant_api_keys': { key_hash: await hashApiKey(key), tenant_id: 'zupa-a', kind: 'public', revoked_at: null },
        'FROM tenants WHERE id': { id: 'zupa-a', status: 'active', allow_sources: '[]' },
        ...rows,
      },
    };
    return worker.fetch(
      new Request('https://mpt.domovina.ai/api/intents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ target_address: '0xa000000000000000000000000000000000000002', amount_eur: '10.00' }),
      }),
      env(f, over),
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
  }

  it('is refused while MULTI_TENANT_RAIL is off', async () => {
    const res = await create({ MULTI_TENANT_RAIL: '0' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'tenant_rail_disabled', tenant_id: 'zupa-a' });
  });

  it('is refused while the tenant has no rail (no QR for an IBAN we cannot see)', async () => {
    const res = await create({});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'tenant_rail_not_configured' });
  });
});

describe('outbound webhooks stay with their tenant', () => {
  it("does not enqueue a tenant's event when that tenant has no endpoint — never the global one", async () => {
    const f: Fake = { sql: [], rows: {} };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await enqueueWebhook(env(f), { id: 'rcv_ord-1', type: 'payment.received', tenantId: 'zupa-a', payload: {} });
    expect(f.sql.some((q) => q.includes('webhook_outbox'))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still delivers the default tenant’s events to the global endpoint', async () => {
    const f: Fake = { sql: [], rows: {} };
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await enqueueWebhook(env(f), { id: 'rcv_ord-2', type: 'payment.received', tenantId: 'italk', payload: {} });
    await enqueueWebhook(env(f), { id: 'rcv_ord-3', type: 'payment.received', tenantId: null, payload: {} });
    expect(f.sql.filter((q) => q.includes('INSERT OR IGNORE INTO webhook_outbox'))).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://pinka.example/hook');
  });
});

describe("an order on tenant X's IBAN never advances tenant Y's intent", () => {
  const intentOfB = {
    sid: 'sid-of-b', tenant_id: 'zupa-b', target_address: '0xb0', state: 'pending',
    monerium_order_id: null,
  } as unknown as PaymentIntentRow;

  it("does not tell Y's merchant 'payment received'", async () => {
    const f: Fake = { sql: [], rows: { 'FROM payment_intents WHERE sid': intentOfB } };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const order = { id: 'ord-9', kind: 'issue', state: 'placed', amount: '5', currency: 'eur', memo: 'mpt:0xb000000000000000000000000000000000000002?sid=sid-of-b' } as MoneriumOrder;
    await notifyOrderLifecycle(env(f), order, 'zupa-a');
    expect(f.sql.some((q) => q.includes('webhook_outbox'))).toBe(false);
    expect(f.sql.some((q) => q.includes('monerium_orders') && q.includes('counterpart_iban'))).toBe(false);
  });

  it("ignores another tenant's order in the intent's status timeline", async () => {
    const f: Fake = {
      sql: [],
      rows: { 'FROM monerium_orders o': { id: 'ord-9', tenant_id: 'zupa-a', state: 'pending' } },
    };
    const ctx = await loadStageContext(env(f), intentOfB);
    expect(ctx.order).toBeNull();
    expect(ctx.forward).toBeNull();
  });

  it("keeps the tenant's own order", async () => {
    const f: Fake = {
      sql: [],
      rows: { 'FROM monerium_orders o': { id: 'ord-9', tenant_id: 'zupa-b', state: 'processed' } },
    };
    const ctx = await loadStageContext(env(f), intentOfB);
    expect(ctx.order?.id).toBe('ord-9');
  });

  it('treats NULL tenant on both sides as the default tenant (pre-0017 rows)', async () => {
    const f: Fake = {
      sql: [],
      rows: { 'FROM monerium_orders o': { id: 'ord-1', tenant_id: null, state: 'processed' } },
    };
    const legacyIntent = { ...intentOfB, tenant_id: null } as unknown as PaymentIntentRow;
    expect((await loadStageContext(env(f), legacyIntent)).order?.id).toBe('ord-1');
  });
});
