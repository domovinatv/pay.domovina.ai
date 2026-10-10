import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// POST /admin/api/forwards/:id/retry (MT-10) on real SQLite.
const HOST = 'https://mpt.domovina.ai';

function setup() {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO admin_sessions (token_hash, email, method, created_at, expires_at)
               VALUES (?, 'ops@domovina.ai', 'passkey', '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z')`)
    .run(createHash('sha256').update('tok').digest('hex'));
  raw.prepare(`INSERT INTO monerium_orders (id, kind, state, amount, currency, raw_json, updated_at, tenant_id)
               VALUES ('ord-1', 'issue', 'processed', '1.00', 'eur', '{"id":"ord-1","kind":"issue","state":"processed","amount":"1.00"}', 0, 'italk')`).run();
  const fwd = (status: string) =>
    Number(raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, status, attempts, created_at, updated_at, error)
                        VALUES ('ord-1', '0xabc', '1', ?, 1, 0, 0, 'rpc down')`).run(status).lastInsertRowid);
  const waits: Promise<unknown>[] = [];
  const env = {
    DB: db,
    ADMIN_EMAILS: 'ops@domovina.ai',
    ADMIN_HOST: 'mpt.domovina.ai',
    ALLOWED_ORIGINS: HOST,
    DEFAULT_TENANT_ID: 'italk',
    SAFE_ADDRESS: '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
  } as unknown as Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p.catch(() => {})); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const retry = (id: number) => worker.fetch(new Request(`${HOST}/admin/api/forwards/${id}/retry`, {
    method: 'POST', headers: { cookie: '__Host-mpt_admin=tok', origin: HOST },
  }), env, ctx);
  return { raw, fwd, retry, waits };
}

describe('admin forward retry', () => {
  it('refuses a forward that is not failed', async () => {
    const { fwd, retry } = setup();
    const res = await retry(fwd('confirmed'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_failed' });
  });

  it('refuses an old failed row once a newer forward exists for the order', async () => {
    const { fwd, retry } = setup();
    const old = fwd('failed');
    fwd('blocked');
    expect((await retry(old)).status).toBe(409);
  });

  it('accepts the latest failed row and audits who did it', async () => {
    const { raw, fwd, retry, waits } = setup();
    const res = await retry(fwd('failed'));
    expect(res.status).toBe(202);
    await Promise.all(waits);
    const audit = raw.prepare(`SELECT action, actor FROM tenant_audit_log WHERE action = 'forward.retry'`).get() as { actor: string };
    expect(audit.actor).toBe('ops@domovina.ai');
  });
});
