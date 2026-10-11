import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// Revoke by the id GET …/keys shows. Before: the listing showed only a
/// shortened hash and DELETE demanded the full one, so no key could ever be
/// revoked through the admin API.
const HOST = 'https://mpt.domovina.ai';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function setup(keys: Array<[tenant: string, hash: string]>) {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO admin_sessions (token_hash, email, method, created_at, expires_at)
               VALUES (?, 'ops@domovina.ai', 'passkey', ?, '2999-01-01T00:00:00Z')`)
    .run(sha('tok'), new Date().toISOString());
  for (const t of ['zupa-a', 'zupa-b']) {
    raw.prepare(`INSERT INTO tenants (id, name, beneficiary_name, iban, created_at, updated_at)
                 VALUES (?, ?, ?, 'HR1210010051863000160', 0, 0)`).run(t, t, t);
  }
  for (const [tenant, hash] of keys) {
    raw.prepare(`INSERT INTO tenant_api_keys (key_hash, tenant_id, kind, created_at) VALUES (?, ?, 'public', 0)`).run(hash, tenant);
  }
  const env = {
    DB: db, ADMIN_EMAILS: 'ops@domovina.ai', ADMIN_HOST: 'mpt.domovina.ai', ALLOWED_ORIGINS: HOST, DEFAULT_TENANT_ID: 'italk',
  } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const call = (method: string, path: string) => worker.fetch(new Request(`${HOST}${path}`, {
    method, headers: { cookie: '__Host-mpt_admin=tok', origin: HOST },
  }), env, ctx);
  const revokedAt = (hash: string) =>
    (raw.prepare(`SELECT revoked_at FROM tenant_api_keys WHERE key_hash = ?`).get(hash) as { revoked_at: number | null }).revoked_at;
  return { call, revokedAt };
}

describe('admin API key revoke', () => {
  const A = sha('key-a');
  const B = sha('key-b');

  it('the id from the listing revokes that key', async () => {
    const { call, revokedAt } = setup([['zupa-a', A]]);
    const list = (await (await call('GET', '/admin/api/tenants/zupa-a/keys')).json()) as { keys: Array<{ id: string }> };
    expect(list.keys[0].id).toBe(A.slice(0, 12));
    const res = await call('DELETE', `/admin/api/tenants/zupa-a/keys/${list.keys[0].id}`);
    expect(res.status).toBe(200);
    expect(revokedAt(A)).not.toBeNull();
    expect((await call('DELETE', `/admin/api/tenants/zupa-a/keys/${list.keys[0].id}`)).status).toBe(404);
  });

  it('the full hash and the shortened form with … still work', async () => {
    const { call, revokedAt } = setup([['zupa-a', A], ['zupa-a', B]]);
    expect((await call('DELETE', `/admin/api/tenants/zupa-a/keys/${A}`)).status).toBe(200);
    expect((await call('DELETE', `/admin/api/tenants/zupa-a/keys/${encodeURIComponent(B.slice(0, 12) + '…')}`)).status).toBe(200);
    expect(revokedAt(A)).not.toBeNull();
    expect(revokedAt(B)).not.toBeNull();
  });

  it("never revokes another tenant's key", async () => {
    const { call, revokedAt } = setup([['zupa-b', A]]);
    expect((await call('DELETE', `/admin/api/tenants/zupa-a/keys/${A.slice(0, 12)}`)).status).toBe(404);
    expect(revokedAt(A)).toBeNull();
  });

  it('an id shared by two active keys of the tenant is refused', async () => {
    const twin = A.slice(0, 12) + 'f'.repeat(52);
    const { call, revokedAt } = setup([['zupa-a', A], ['zupa-a', twin]]);
    const res = await call('DELETE', `/admin/api/tenants/zupa-a/keys/${A.slice(0, 12)}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'ambiguous_key_ref' });
    expect(revokedAt(A)).toBeNull();
  });

  it.each(['xyz', 'abcd', 'g'.repeat(12)])('rejects a malformed ref %s', async (ref) => {
    const { call } = setup([['zupa-a', A]]);
    expect((await call('DELETE', `/admin/api/tenants/zupa-a/keys/${ref}`)).status).toBe(400);
  });
});
