import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// Admin v2: alati koji su bili samo u v1 (walleti, sybil, alert test,
/// passkeyi) i novi PUT …/allow-sources. Kroz cijeli Worker, s pravom
/// admin sesijom, da prijava, CSP i CSRF budu isti kao na produkciji.
const HOST = 'https://mpt.domovina.ai';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const PHONE = 'ab'.repeat(32);
const SAFE1 = '0x1111111111111111111111111111111111111111';
const SAFE2 = '0x2222222222222222222222222222222222222222';

function setup() {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO admin_sessions (token_hash, email, method, created_at, expires_at)
               VALUES (?, 'ops@domovina.ai', 'passkey', ?, '2999-01-01T00:00:00Z')`).run(sha('tok'), new Date().toISOString());
  raw.prepare(`INSERT INTO admin_passkeys (id, email, public_key, label, created_at) VALUES
               ('pk-ops', 'ops@domovina.ai', 'x', 'MacBook ops', '2026-11-01T10:00:00Z'),
               ('pk-other', 'drugi@domovina.ai', 'x', 'Tuđi ključ', '2026-11-01T10:00:00Z')`).run();
  raw.prepare(`INSERT OR REPLACE INTO tenants (id, name, status, beneficiary_name, iban, created_at, updated_at)
               VALUES ('italk', 'ITalk d.o.o.', 'active', 'ITalk', 'EE701234567890121128', 0, 0)`).run();
  const wallet = (cred: string, safe: string, phone: string | null) => raw.prepare(
    `INSERT INTO wallet_registry (credential_id, pub_key_x, pub_key_y, signer_address, safe_address, phone_hash, rp_id, created_at, recovery_owner)
     VALUES (?, '1', '2', '0x9999999999999999999999999999999999999999', ?, ?, 'wallet.domovina.ai', 1760000000, NULL)`,
  ).run(cred, safe, phone);
  wallet('0xc1', SAFE1, PHONE);
  wallet('0xc2', SAFE2, PHONE);
  wallet('0xc3', '0x3333333333333333333333333333333333333333', null);
  raw.prepare(`INSERT INTO wallet_phone_bindings (credential_id, phone_hash, first_bound_at, latest_verified_at, verification_count)
               VALUES ('0xc1', ?, 1760000000, 1760000100, 2), ('0xc2', ?, 1760000200, 1760000300, 1)`).run(PHONE, PHONE);
  const env = {
    DB: db, ADMIN_EMAILS: 'ops@domovina.ai', ADMIN_HOST: 'mpt.domovina.ai', ALLOWED_ORIGINS: HOST, DEFAULT_TENANT_ID: 'italk',
  } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const call = (method: string, path: string, body?: unknown, origin = HOST) => worker.fetch(new Request(`${HOST}${path}`, {
    method,
    headers: { cookie: '__Host-mpt_admin=tok', origin, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const html = async (path: string) => {
    const r = await call('GET', path);
    expect(r.status, path).toBe(200);
    return r.text();
  };
  return { raw, call, html };
}

describe('admin v2 alati iz v1', () => {
  it('walleti: lista, skraćeni hash telefona i oznaka dijeljenog telefona', async () => {
    const { html } = setup();
    const page = await html('/admin/v2/wallets');
    expect(page).toContain('3 ukupno · 2 s telefonom');
    expect(page).toContain(`${PHONE.slice(0, 10)}…${PHONE.slice(-6)}`);
    expect(page).toContain('dijeli ga više walleta');
    const phoneOnly = await html('/admin/v2/wallets?phone=1');
    expect(phoneOnly).not.toContain('0x3333');
  });

  it('sybil: klaster i drill-down sa Safe adresama', async () => {
    const { html } = setup();
    const list = await html('/admin/v2/wallets/sybil');
    expect(list).toContain(`/admin/v2/wallets/sybil?phone=${PHONE}`);
    const drill = await html(`/admin/v2/wallets/sybil?phone=${PHONE}`);
    expect(drill).toContain(SAFE1);
    expect(drill).toContain(SAFE2);
    // Neispravan hash se ignorira (bez drill-downa), ne puca.
    expect(await html('/admin/v2/wallets/sybil?phone=nije-hash')).not.toContain('Walleti s telefonom');
  });

  it('postavke: alert test gumb i samo vlastiti passkeyi, passkey.js bez noncea', async () => {
    const { html } = setup();
    const page = await html('/admin/v2/settings');
    expect(page).toContain('data-post="/admin/api/alert-test"');
    expect(page).toContain('MacBook ops');
    expect(page).not.toContain('Tuđi ključ');
    expect(page).toContain('id="passkey-register"');
    expect(page).toContain('<script src="/admin/static/passkey.js">');
  });

  it('nav vodi na v2 stranice, ne na v1', async () => {
    const { html } = setup();
    const page = await html('/admin/v2/settings');
    expect(page).toContain('href="/admin/v2/wallets"');
    expect(page).not.toContain('href="/admin/sybil"');
    expect(page).not.toContain('href="/admin/passkeys"');
  });

  it('PUT allow-sources: uključi, idempotentno, audit, isključi', async () => {
    const { call, raw } = setup();
    const src = () => (raw.prepare(`SELECT allow_sources FROM tenants WHERE id = 'italk'`).get() as { allow_sources: string }).allow_sources;
    const on = await call('PUT', '/admin/api/tenants/italk/allow-sources', { sources: ['wallet_registry'] });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ changed: true, allow_sources: ['wallet_registry'] });
    expect(JSON.parse(src())).toEqual(['wallet_registry']);
    const again = await call('PUT', '/admin/api/tenants/italk/allow-sources', { sources: ['wallet_registry'] });
    expect(await again.json()).toMatchObject({ changed: false });
    const audit = raw.prepare(`SELECT actor, detail FROM tenant_audit_log WHERE action = 'tenant.allow_sources'`).all() as Array<{ actor: string; detail: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toBe('ops@domovina.ai');
    expect(JSON.parse(audit[0].detail)).toEqual({ before: [], after: ['wallet_registry'] });
    const off = await call('PUT', '/admin/api/tenants/italk/allow-sources', { sources: [] });
    expect(await off.json()).toMatchObject({ changed: true, allow_sources: [] });
    expect(JSON.parse(src())).toEqual([]);
  });

  it('PUT allow-sources: nepoznat izvor, loš oblik, nepostojeći tenant, tuđi origin', async () => {
    const { call, raw } = setup();
    const before = (raw.prepare(`SELECT allow_sources FROM tenants WHERE id = 'italk'`).get() as { allow_sources: string }).allow_sources;
    const bad = await call('PUT', '/admin/api/tenants/italk/allow-sources', { sources: ['wallet_registry', 'sve_adrese'] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'unknown_allow_source', detail: 'sve_adrese' });
    expect((await call('PUT', '/admin/api/tenants/italk/allow-sources', { sources: 'wallet_registry' })).status).toBe(400);
    expect((await call('PUT', '/admin/api/tenants/nema/allow-sources', { sources: [] })).status).toBe(404);
    const csrf = await call('PUT', '/admin/api/tenants/italk/allow-sources', { sources: ['wallet_registry'] }, 'https://evil.example');
    expect(csrf.status).toBe(403);
    expect((raw.prepare(`SELECT allow_sources FROM tenants WHERE id = 'italk'`).get() as { allow_sources: string }).allow_sources).toBe(before);
  });

  it('primatelji: gumb za wallet_registry na forward tenantu', async () => {
    const { html } = setup();
    const page = await html('/admin/v2/tenants/italk/recipients');
    expect(page).toContain('Dinamički izvori whiteliste');
    expect(page).toContain('data-post="/admin/api/tenants/italk/allow-sources"');
    expect(page).toContain('Uključi wallet_registry');
  });
});
