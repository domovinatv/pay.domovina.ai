import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// Admin "+ Novi intent" creates the intent ON BEHALF OF the picked tenant,
/// through the same path as POST /api/intents.

const HOST = 'https://mpt.domovina.ai';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const TARGET = '0x000000000000000000000000000000000000dEaD';

function setup() {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO admin_sessions (token_hash, email, method, created_at, expires_at)
               VALUES (?, 'ops@domovina.ai', 'passkey', ?, '2999-01-01T00:00:00Z')`).run(sha('tok'), new Date().toISOString());
  raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, sandbox, created_at, updated_at)
               VALUES ('sbx-abc', 'Sandbox', 'active', '[]', 'Sandbox', 'HR1210010051863000160', 1, 0, 0)`).run();
  raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
               VALUES ('paused', 'Paused', 'suspended', '[]', 'Paused', 'HR1210010051863000160', 0, 0)`).run();
  const env = {
    DB: db, ADMIN_EMAILS: 'ops@domovina.ai', ADMIN_HOST: 'mpt.domovina.ai', ALLOWED_ORIGINS: HOST,
    DEFAULT_TENANT_ID: 'italk', MULTI_TENANT_RAIL: '1', INTENT_REQUIRE_TENANT_KEY: '0', SANDBOX_SELF_SERVE: '1',
  } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const post = (body: unknown, cookie = '__Host-mpt_admin=tok') => worker.fetch(new Request(`${HOST}/admin/api/intents`, {
    method: 'POST', headers: { cookie, origin: HOST, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), env, ctx);
  return { post, raw };
}

describe('POST /admin/api/intents', () => {
  it('creates a trusted intent for the picked sandbox tenant', async () => {
    const { post, raw } = setup();
    const res = await post({ tenant_id: 'sbx-abc', target_address: TARGET, amount_eur: '12.34' });
    expect(res.status).toBe(200);
    const { sid } = (await res.json()) as { sid: string };
    const row = raw.prepare(`SELECT tenant_id, amount_cents, created_with_key FROM payment_intents WHERE sid = ?`).get(sid);
    expect(row).toEqual({ tenant_id: 'sbx-abc', amount_cents: 1234, created_with_key: 1 });
    expect(raw.prepare(`SELECT action FROM tenant_audit_log WHERE tenant_id = 'sbx-abc'`).all()).toEqual([{ action: 'intent.create_admin' }]);
  });

  it('missing / unknown / suspended tenant is refused', async () => {
    const { post } = setup();
    expect((await post({ target_address: TARGET, amount_eur: '1' })).status).toBe(400);
    expect((await post({ tenant_id: 'nope', target_address: TARGET, amount_eur: '1' })).status).toBe(401);
    expect((await post({ tenant_id: 'paused', target_address: TARGET, amount_eur: '1' })).status).toBe(403);
  });

  it('needs an admin session', async () => {
    const { post } = setup();
    const res = await post({ tenant_id: 'sbx-abc', target_address: TARGET, amount_eur: '1' }, '');
    expect([302, 401, 403]).toContain(res.status);
  });
});

describe('intents page modal', () => {
  it('fills the tenant select after openModal re-renders the form, and the script parses', async () => {
    const { renderIntentsPage } = await import('../src/admin/views');
    const html = renderIntentsPage();
    expect(html).toContain("addEventListener('click', () => { openModal(); fillModalTenants(); })");
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1])).not.toThrow();
  });
});
