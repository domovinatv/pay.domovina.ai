import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0032: receiving accounts are managed from /admin/tenants, secrets
/// never come back out.

const HOST = 'https://mpt.domovina.ai';
const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function setup() {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO admin_sessions (token_hash, email, method, created_at, expires_at)
               VALUES (?, 'ops@domovina.ai', 'passkey', ?, '2999-01-01T00:00:00Z')`).run(sha('tok'), new Date().toISOString());
  raw.prepare(`INSERT INTO tenants (id, name, beneficiary_name, iban, created_at, updated_at)
               VALUES ('zupa-a', 'zupa-a', 'zupa-a', 'HR1210010051863000160', 0, 0)`).run();
  const env = {
    DB: db, ADMIN_EMAILS: 'ops@domovina.ai', ADMIN_HOST: 'mpt.domovina.ai', ALLOWED_ORIGINS: HOST,
    DEFAULT_TENANT_ID: 'italk', TENANT_SECRETS_KEK: KEK, PUBLIC_API_BASE: 'https://api.mpt.hr',
  } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const call = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`${HOST}${path}`, {
    method,
    headers: { cookie: '__Host-mpt_admin=tok', origin: HOST, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  return { call, raw };
}

describe('admin receiving accounts', () => {
  it('create → list (redacted, with webhook URL) → deactivate', async () => {
    const { call, raw } = setup();
    const created = await call('POST', '/admin/api/tenants/zupa-a/receiving-accounts', {
      provider: 'swan', environment: 'sandbox', external_account_id: 'acc-1', client_id: 'cid', client_secret: 'top-secret',
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };

    const list = await (await call('GET', '/admin/api/tenants/zupa-a/receiving-accounts')).text();
    expect(list).not.toContain('top-secret');
    expect(JSON.parse(list).accounts[0]).toMatchObject({
      id, provider: 'swan', mode: 'fiat_notify', environment: 'sandbox', external_account_id: 'acc-1',
      has_client_secret: 1, has_webhook_secret: 0, active: 1, webhook_url: 'https://api.mpt.hr/api/swan/webhook/t/zupa-a',
    });
    expect((raw.prepare(`SELECT client_secret_enc FROM receiving_accounts`).get() as { client_secret_enc: string }).client_secret_enc).toMatch(/^v1:/);

    expect((await call('POST', `/admin/api/tenants/zupa-a/receiving-accounts/${id}/deactivate`)).status).toBe(200);
    expect((await call('POST', `/admin/api/tenants/zupa-a/receiving-accounts/${id}/deactivate`)).status).toBe(404);
    expect((await call('POST', `/admin/api/tenants/other/receiving-accounts/${id}/deactivate`)).status).toBe(404);
  });

  it('missing fields and unknown provider are 400; duplicate account is 409', async () => {
    const { call } = setup();
    expect((await call('POST', '/admin/api/tenants/zupa-a/receiving-accounts', { provider: 'swan' })).status).toBe(400);
    expect((await call('POST', '/admin/api/tenants/zupa-a/receiving-accounts', { provider: 'wise' })).status).toBe(400);
    const b = { provider: 'swan', external_account_id: 'acc-1', client_id: 'c', client_secret: 's' };
    expect((await call('POST', '/admin/api/tenants/zupa-a/receiving-accounts', b)).status).toBe(201);
    expect((await call('POST', '/admin/api/tenants/zupa-a/receiving-accounts', b)).status).toBe(409);
  });

  it('the tenants page carries the section', async () => {
    const { call } = setup();
    const html = await (await call('GET', '/admin/tenants')).text();
    expect(html).toContain('Računi primatelja (ADR 0032)');
    expect(html).toContain('id="raAdd"');
  });
});
