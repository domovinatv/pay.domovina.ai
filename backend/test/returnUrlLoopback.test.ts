import { describe, expect, it } from 'vitest';
import { returnUrlAllowsLoopback } from '../src/intents/api';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0024 D6: an http loopback return_url is for local development, so it
/// is allowed wherever no real money moves: self-serve sandbox tenants and
/// rail tenants on Monerium's sandbox.

function setup() {
  const { db, raw } = migratedD1();
  for (const [id, moneriumEnv] of [['sbx-rail', 'sandbox'], ['live-rail', 'production']]) {
    raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
                 VALUES (?, ?, 'active', '[]', ?, 'HR0000000000000000000', 0, 0)`).run(id, id, id);
    raw.prepare(`INSERT INTO tenant_rail (tenant_id, monerium_env, chain, client_id, client_secret_enc, profile_id, receiving_safe, router_key_enc, created_at, updated_at)
                 VALUES (?, ?, 'chiado', 'cid', 'x', ?, '0x0', 'x', 0, 0)`).run(id, moneriumEnv, `pid-${id}`);
  }
  return { DB: db } as unknown as Env;
}

describe('returnUrlAllowsLoopback', () => {
  it('allows a self-serve sandbox tenant', async () => {
    expect(await returnUrlAllowsLoopback(setup(), { tenantId: 'sbx-0000000000', sandbox: true })).toBe(true);
  });

  it('allows a rail tenant on Monerium sandbox', async () => {
    expect(await returnUrlAllowsLoopback(setup(), { tenantId: 'sbx-rail' })).toBe(true);
  });

  it('refuses a production rail tenant', async () => {
    expect(await returnUrlAllowsLoopback(setup(), { tenantId: 'live-rail' })).toBe(false);
  });

  it('refuses a tenant without a rail (the legacy default tenant)', async () => {
    expect(await returnUrlAllowsLoopback(setup(), { tenantId: 'italk' })).toBe(false);
  });
});
