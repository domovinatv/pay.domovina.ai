import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import type { Env } from '../src/types';

/// Route-level checks for /api/monerium/webhook/t/:tenantId (ADR 0017): the
/// URL decides the tenant, and anything unresolved is a 404 — never ITalk.

function fakeDb(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const stmt = (q: string) => ({
    bind: () => stmt(q),
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 1, last_row_id: 1 } }),
  });
  const db = {
    prepare(q: string) {
      sql.push(q);
      return stmt(q);
    },
  } as unknown as D1Database;
  return { db, sql };
}

function env(over: Partial<Env> = {}): Env {
  return {
    ALLOWED_ORIGINS: 'https://mpt.domovina.ai',
    DEFAULT_TENANT_ID: 'italk',
    MULTI_TENANT_RAIL: '1',
    TENANT_SECRETS_KEK: '',
    ...over,
  } as unknown as Env;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function post(path: string, e: Env): Promise<Response> {
  return worker.fetch(
    new Request(`https://mpt.domovina.ai${path}`, { method: 'POST', body: '{"type":"order.updated"}' }),
    e,
    ctx,
  );
}

describe('POST /api/monerium/webhook/t/:tenantId', () => {
  it('is 404 while MULTI_TENANT_RAIL is off, without touching D1', async () => {
    const { db, sql } = fakeDb();
    const res = await post('/api/monerium/webhook/t/zupa-a', env({ DB: db, MULTI_TENANT_RAIL: '0' }));
    expect(res.status).toBe(404);
    expect(sql).toHaveLength(0);
  });

  it('is 404 for a tenant without a rail, and records the attempt', async () => {
    const { db, sql } = fakeDb();
    const res = await post('/api/monerium/webhook/t/zupa-x', env({ DB: db }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_tenant' });
    expect(sql.some((q) => q.includes('FROM tenant_rail'))).toBe(true);
    expect(sql.some((q) => q.includes('INSERT INTO monerium_webhook_events'))).toBe(true);
  });

  it('MT-04: a body over 64 KB is refused before D1, on both URLs', async () => {
    for (const path of ['/api/monerium/webhook', '/api/monerium/webhook/t/zupa-a']) {
      const { db, sql } = fakeDb();
      const res = await worker.fetch(
        new Request(`https://mpt.domovina.ai${path}`, { method: 'POST', body: 'x'.repeat(70_000) }),
        env({ DB: db }),
        ctx,
      );
      expect(res.status).toBe(413);
      expect(sql).toHaveLength(0);
    }
  });

  it('does not serve the default tenant on the per-tenant URL', async () => {
    const { db, sql } = fakeDb();
    const res = await post('/api/monerium/webhook/t/italk', env({ DB: db }));
    expect(res.status).toBe(404);
    expect(sql.some((q) => q.includes('FROM tenant_rail'))).toBe(false);
  });
});
