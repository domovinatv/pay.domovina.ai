import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import {
  MIN_ROUTER_GAS_WEI,
  nextStatus,
  redactRail,
  runVerify,
  validateCreateTenant,
  validateRailInput,
  webhookUrlFor,
  type VerifyDeps,
} from '../src/tenants/onboarding';
import type { TenantRailRow } from '../src/tenants/rail';
import type { Env } from '../src/types';

const SAFE = '0xa000000000000000000000000000000000000001';
const MOD = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';

function row(over: Partial<TenantRailRow> = {}): TenantRailRow {
  return {
    tenant_id: 'zupa-a', monerium_env: 'production', chain: 'gnosis', auth_kind: 'client_credentials',
    client_id: 'cid', client_secret_enc: 'v1:a:b', refresh_token_enc: null, profile_id: 'prof-a',
    receiving_safe: SAFE, roles_modifier: MOD, role_key: '0x' + '45'.repeat(32), router_address: ROUTER,
    router_key_enc: 'v1:c:d', eure_contract: null, rpc_url: null, webhook_secret_enc: 'v1:e:f',
    webhook_subscription_id: 'sub-1', outbound_webhook_url: null, outbound_webhook_secret_enc: null,
    max_forward_cents: 500_000, verified_at: null, verify_report: null, created_at: 0, updated_at: 0,
    ...over,
  };
}

function deps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    authProfiles: async () => ['prof-a'],
    listIbans: async () => [{ iban: 'HR1210010051863000160', profile: 'prof-a', address: SAFE, chain: 'gnosis' }],
    getCode: async () => '0x6080',
    isModuleEnabled: async () => true,
    avatar: async () => SAFE,
    target: async () => SAFE,
    balanceWei: async () => MIN_ROUTER_GAS_WEI,
    activeWhitelistCount: async () => 2,
    ...over,
  };
}

const tenant = { iban: 'HR12 1001 0051 8630 0016 0' };

describe('validateCreateTenant', () => {
  it('normalises id, IBAN and BIC', () => {
    expect(validateCreateTenant({ id: 'Zupa-A', name: 'Župa A', iban: 'hr12 1001 0051 8630 0016 0', bic: 'zabahr2x' }))
      .toEqual({ ok: true, value: { id: 'zupa-a', name: 'Župa A', beneficiaryName: 'Župa A', iban: 'HR1210010051863000160', bic: 'ZABAHR2X' } });
  });
  it.each([
    [{ id: 'x', name: 'n', iban: 'HR1210010051863000160' }, 'invalid_tenant_id'],
    [{ id: 'zupa-a', name: '', iban: 'HR1210010051863000160' }, 'name_required'],
    [{ id: 'zupa-a', name: 'n', iban: 'nope' }, 'invalid_iban'],
    [{ id: 'zupa-a', name: 'n', iban: 'HR1210010051863000160', bic: 'X' }, 'invalid_bic'],
  ])('rejects %j', (body, error) => {
    expect(validateCreateTenant(body as Record<string, unknown>)).toEqual({ ok: false, error });
  });
});

describe('validateRailInput', () => {
  const base = { client_id: 'cid', client_secret: 's', profile_id: 'prof-a', receiving_safe: SAFE };
  it('accepts a minimal production rail', () => {
    const v = validateRailInput(base, null);
    expect(v.ok && v.value).toMatchObject({ moneriumEnv: 'production', chain: 'gnosis', receivingSafe: SAFE });
  });
  it('requires a client secret only for a new rail', () => {
    expect(validateRailInput({ ...base, client_secret: '' }, null)).toEqual({ ok: false, error: 'client_secret_required' });
    const v = validateRailInput({ ...base, client_secret: '' }, row());
    expect(v.ok && v.value.clientSecret).toBeNull();
  });
  it.each([
    [{ receiving_safe: '0x123' }, 'invalid_receiving_safe'],
    [{ monerium_env: 'staging' }, 'invalid_monerium_env'],
    [{ chain: 'polygon' }, 'invalid_chain'],
    [{ chain: 'chiado' }, 'eure_contract_required_on_chiado'],
    [{ role_key: '0xabc' }, 'invalid_role_key'],
    [{ max_forward_cents: '0' }, 'invalid_max_forward_cents'],
    [{ max_forward_cents: '1000001' }, 'invalid_max_forward_cents'],
    [{ outbound_webhook_url: 'http://x' }, 'invalid_outbound_webhook_url'],
    [{ outbound_webhook_url: 'https://x' }, 'outbound_webhook_secret_required'],
  ])('rejects %j', (over, error) => {
    expect(validateRailInput({ ...base, ...over }, null)).toEqual({ ok: false, error });
  });
});

describe('redactRail', () => {
  it('never exposes a secret, only whether it is set', () => {
    const out = JSON.stringify(redactRail(row()));
    for (const blob of ['v1:a:b', 'v1:c:d', 'v1:e:f']) expect(out).not.toContain(blob);
    expect(redactRail(row())).toMatchObject({ has_client_secret: true, has_router_key: true, has_webhook_secret: true });
  });
});

describe('runVerify', () => {
  it('passes everything for a correctly onboarded tenant', async () => {
    const checks = await runVerify(deps(), tenant, row(), true);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.key)).toEqual([
      'monerium_profile', 'iban_linked_to_safe', 'safe_deployed', 'roles_modifier',
      'role_key', 'router_gas', 'webhook', 'whitelist', 'forward_cap',
    ]);
  });

  it.each([
    ['profile not reachable with these credentials', { authProfiles: async () => ['prof-x'] }, 'monerium_profile'],
    ['IBAN mints to another address', { listIbans: async () => [{ iban: 'HR1210010051863000160', address: ROUTER, chain: 'gnosis' }] }, 'iban_linked_to_safe'],
    ['IBAN not on the profile', { listIbans: async () => [] }, 'iban_linked_to_safe'],
    ['Safe not deployed', { getCode: async () => undefined }, 'safe_deployed'],
    ['module not enabled', { isModuleEnabled: async () => false }, 'roles_modifier'],
    ['modifier avatar is another Safe', { avatar: async () => ROUTER }, 'roles_modifier'],
    ['router without gas', { balanceWei: async () => 1n }, 'router_gas'],
    ['empty whitelist', { activeWhitelistCount: async () => 0 }, 'whitelist'],
    ['RPC throws', { getCode: async () => { throw new Error('rpc down'); } }, 'safe_deployed'],
  ])('fails only %s', async (_n, over, failing) => {
    const checks = await runVerify(deps(over as Partial<VerifyDeps>), tenant, row(), true);
    expect(checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([failing]);
  });

  it('fails missing config without calling the chain', async () => {
    const checks = await runVerify(deps(), tenant, row({ webhook_subscription_id: null, max_forward_cents: null, router_address: null }), false);
    expect(checks.filter((c) => !c.ok).map((c) => c.key)).toEqual(['router_gas', 'webhook', 'forward_cap']);
  });
});

describe('status transitions', () => {
  it.each([
    ['onboarding', 'activate', true, { ok: true, status: 'active' }],
    ['onboarding', 'activate', false, { ok: false, error: 'rail_not_verified' }],
    ['active', 'suspend', false, { ok: true, status: 'suspended' }],
    ['suspended', 'resume', true, { ok: true, status: 'active' }],
    ['suspended', 'resume', false, { ok: false, error: 'rail_not_verified' }],
    ['onboarding', 'suspend', true, { ok: false, error: 'cannot_suspend_onboarding' }],
    ['active', 'activate', true, { ok: false, error: 'cannot_activate_active' }],
  ] as const)('%s + %s (verified=%s)', (from, t, verified, expected) => {
    expect(nextStatus(from, t, verified)).toEqual(expected);
  });
});

it('builds the per-tenant webhook URL', () => {
  expect(webhookUrlFor('https://mpt.domovina.ai/', 'zupa-a')).toBe('https://mpt.domovina.ai/api/monerium/webhook/t/zupa-a');
});

describe('admin routes', () => {
  function fakeEnv(rows: Record<string, unknown>): { env: Env; sql: string[] } {
    // Valid admin session for the cookie below (src/admin/auth/session.ts).
    rows = { 'FROM admin_sessions': { email: 'ops@domovina.ai', method: 'access', expires_at: '2999-01-01T00:00:00Z' }, ...rows };
    const sql: string[] = [];
    const exec = (q: string) => ({
      first: async () => {
        for (const [k, v] of Object.entries(rows)) if (q.includes(k)) return v;
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 1 } }),
    });
    const env = {
      DB: { prepare: (q: string) => { sql.push(q); return { bind: () => exec(q), ...exec(q) }; } },
      ALLOWED_ORIGINS: 'https://mpt.domovina.ai',
      DEFAULT_TENANT_ID: 'italk',
      ADMIN_EMAILS: 'ops@domovina.ai',
    } as unknown as Env;
    return { env, sql };
  }
  const auth = { cookie: '__Host-mpt_admin=test-token', origin: 'https://mpt.domovina.ai', 'content-type': 'application/json' };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const call = (env: Env, method: string, path: string, body?: unknown) =>
    worker.fetch(new Request('https://mpt.domovina.ai' + path, { method, headers: auth, body: body ? JSON.stringify(body) : undefined }), env, ctx);

  it('refuses to touch the default tenant', async () => {
    const { env, sql } = fakeEnv({});
    for (const [m, p] of [['PUT', '/admin/api/tenants/italk/rail'], ['POST', '/admin/api/tenants/italk/suspend'], ['POST', '/admin/api/tenants/italk/rail/router-key']]) {
      const res = await call(env, m, p, {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'default_tenant_uses_env' });
    }
    expect(sql.some((q) => q.startsWith('UPDATE'))).toBe(false);
  });

  it('refuses to change the rail of an active tenant', async () => {
    const { env, sql } = fakeEnv({ 'FROM tenants WHERE id': { id: 'zupa-a', status: 'active' }, 'FROM tenant_rail': row() });
    const res = await call(env, 'PUT', '/admin/api/tenants/zupa-a/rail', { client_id: 'x', profile_id: 'p', receiving_safe: SAFE });
    expect(res.status).toBe(409);
    expect(sql.some((q) => q.includes('INSERT INTO tenant_rail'))).toBe(false);
  });

  it('refuses activation before a passed verify', async () => {
    const { env, sql } = fakeEnv({ 'FROM tenants WHERE id': { id: 'zupa-a', status: 'onboarding' }, 'FROM tenant_rail': row({ verified_at: null }) });
    const res = await call(env, 'POST', '/admin/api/tenants/zupa-a/activate');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'rail_not_verified' });
    expect(sql.some((q) => q.startsWith('UPDATE tenants'))).toBe(false);
  });

  it('requires admin auth', async () => {
    const { env } = fakeEnv({});
    const res = await worker.fetch(new Request('https://mpt.domovina.ai/admin/api/tenants', {
      method: 'POST', body: '{}', headers: { origin: 'https://mpt.domovina.ai' },
    }), env, ctx);
    expect(res.status).toBe(401);
  });
});
