import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import {
  envRailBody,
  legacySubscriptionId,
  PROJECT_ROUTER_ROLE_KEY,
  MIN_ROUTER_GAS_WEI,
  MIN_ROUTER_GAS_WEI_CHIADO,
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
    listModules: async () => [MOD.toLowerCase()],
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
      'monerium_profile', 'iban_linked_to_safe', 'safe_deployed', 'roles_modifier', 'only_module_is_roles',
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
    ['TD-05: another module enabled on the Safe', { listModules: async () => [MOD.toLowerCase(), '0x' + '77'.repeat(20)] }, 'only_module_is_roles'],
    ['RPC throws', { getCode: async () => { throw new Error('rpc down'); } }, 'safe_deployed'],
  ])('fails only %s', async (_n, over, failing) => {
    const checks = await runVerify(deps(over as Partial<VerifyDeps>), tenant, row(), true);
    expect(checks.filter((c) => !c.ok).map((c) => c.key)).toEqual([failing]);
  });

  it('holds a Chiado router to the lower sandbox threshold', async () => {
    const chiado = row({ monerium_env: 'sandbox', chain: 'chiado' });
    const gas = (bal: bigint) =>
      runVerify(deps({ balanceWei: async () => bal }), tenant, chiado, true)
        .then((checks) => checks.find((c) => c.key === 'router_gas')!.ok);
    expect(await gas(MIN_ROUTER_GAS_WEI_CHIADO)).toBe(true);
    expect(await gas(MIN_ROUTER_GAS_WEI_CHIADO - 1n)).toBe(false);
    expect(MIN_ROUTER_GAS_WEI_CHIADO < MIN_ROUTER_GAS_WEI).toBe(true);
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

describe('ITalk env rail → D1 row', () => {
  const env = {
    MONERIUM_BASE_URL: 'https://api.monerium.app',
    MONERIUM_CLIENT_ID: 'cid-prod',
    MONERIUM_CLIENT_SECRET: 'sec-prod',
    SAFE_ADDRESS: '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
    ROLES_MODIFIER_ADDRESS: '0x330347d656b1a5DF972f758DE1E25E99ec36762c',
    EURE_CONTRACT: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
    GNOSIS_RPC_URL: '',
    INTENT_WEBHOOK_URL: 'https://api.domovina.ai/functions/v1/pinka-webhook',
    INTENT_WEBHOOK_SECRET: 'whsec_x',
  } as unknown as Env;

  it('becomes a valid direct rail with the ProjectRouter role on the same Safe', () => {
    const v = validateRailInput(envRailBody(env, 'prof-italk'), null);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value).toMatchObject({
      moneriumEnv: 'production', chain: 'gnosis', mode: 'direct',
      clientId: 'cid-prod', clientSecret: 'sec-prod', profileId: 'prof-italk',
      receivingSafe: '0x449abcef4e29a7dd8d98db451af2c463561baf2e',
      rolesModifier: '0x330347d656b1a5df972f758de1e25e99ec36762c',
      roleKey: PROJECT_ROUTER_ROLE_KEY,
      rpcUrl: null,
      outboundWebhookUrl: 'https://api.domovina.ai/functions/v1/pinka-webhook',
      outboundWebhookSecret: 'whsec_x',
    });
    expect(PROJECT_ROUTER_ROLE_KEY.slice(2, 28)).toBe(Buffer.from('ProjectRouter').toString('hex'));
  });

  it('refuses an unknown Monerium host instead of guessing', () => {
    const v = validateRailInput(envRailBody({ ...env, MONERIUM_BASE_URL: 'https://evil.example' } as Env, 'p'), null);
    expect(v).toEqual({ ok: false, error: 'invalid_monerium_env' });
  });

  it('finds the one live shared-webhook subscription, nothing else', () => {
    const shared = { id: 's1', url: 'https://mpt.domovina.ai/api/monerium/webhook', state: 'active' };
    expect(legacySubscriptionId([shared, { id: 's2', url: 'https://mpt.domovina.ai/api/monerium/webhook/t/x' }])).toBe('s1');
    expect(legacySubscriptionId([{ ...shared, state: 'disabled' }])).toBeNull();
    expect(legacySubscriptionId([shared, { ...shared, id: 's3', url: 'https://pay.domovina.ai/api/monerium/webhook' }])).toBeNull();
  });
});

describe('admin routes', () => {
  function fakeEnv(rows: Record<string, unknown>): { env: Env; sql: string[] } {
    // Valid admin session for the cookie below (src/admin/auth/session.ts).
    rows = { 'FROM admin_sessions': { email: 'ops@domovina.ai', method: 'access', created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), expires_at: '2999-01-01T00:00:00Z' }, ...rows };
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

  // behavior-change (italk → D1): the default tenant's rail row is prepared
  // through the same admin flow while the env rail still serves it; only the
  // per-tenant webhook stays closed until the env rail is gone.
  it('lets the admin prepare the default tenant rail, but not its webhook', async () => {
    const { env } = fakeEnv({ 'FROM tenants WHERE id': { id: 'italk', status: 'suspended' } });
    const put = await call(env, 'PUT', '/admin/api/tenants/italk/rail', {});
    expect(put.status).toBe(400);
    expect(await put.json()).not.toEqual({ error: 'default_tenant_uses_env' });
    const key = await call(env, 'POST', '/admin/api/tenants/italk/rail/router-key');
    expect(await key.json()).toEqual({ error: 'rail_not_found' });
    const hook = await call(env, 'POST', '/admin/api/tenants/italk/rail/webhook');
    expect(hook.status).toBe(400);
    expect(await hook.json()).toEqual({ error: 'default_tenant_uses_env' });
  });

  it('imports the env rail only for the default tenant, suspended, without a row', async () => {
    const other = fakeEnv({ 'FROM tenants WHERE id': { id: 'zupa-a', status: 'suspended' } });
    expect(await (await call(other.env, 'POST', '/admin/api/tenants/zupa-a/rail/import-env')).json()).toEqual({ error: 'only_default_tenant' });
    const active = fakeEnv({ 'FROM tenants WHERE id': { id: 'italk', status: 'active' } });
    expect(await (await call(active.env, 'POST', '/admin/api/tenants/italk/rail/import-env')).json()).toEqual({ error: 'suspend_first' });
    const exists = fakeEnv({ 'FROM tenants WHERE id': { id: 'italk', status: 'suspended' }, 'FROM tenant_rail': row({ tenant_id: 'italk' }) });
    expect(await (await call(exists.env, 'POST', '/admin/api/tenants/italk/rail/import-env')).json()).toEqual({ error: 'rail_exists' });
    for (const e of [other, active, exists]) expect(e.sql.some((q) => q.includes('INSERT INTO tenant_rail'))).toBe(false);
  });

  it('refuses to change the rail of an active tenant', async () => {
    const { env, sql } = fakeEnv({ 'FROM tenants WHERE id': { id: 'zupa-a', status: 'active' }, 'FROM tenant_rail': row() });
    const res = await call(env, 'PUT', '/admin/api/tenants/zupa-a/rail', { client_id: 'x', profile_id: 'p', receiving_safe: SAFE });
    expect(res.status).toBe(409);
    expect(sql.some((q) => q.includes('INSERT INTO tenant_rail'))).toBe(false);
  });

  it('refuses a Monerium profile that already belongs to another tenant', async () => {
    const body = { client_id: 'x', client_secret: 's', profile_id: 'prof-b', receiving_safe: SAFE };
    const taken = fakeEnv({ 'FROM tenants WHERE id': { id: 'zupa-a', status: 'onboarding' }, 'WHERE profile_id = ?': { tenant_id: 'zupa-b' } });
    const res = await call(taken.env, 'PUT', '/admin/api/tenants/zupa-a/rail', body);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'profile_in_use' });
    expect(taken.sql.some((q) => q.includes('INSERT INTO tenant_rail'))).toBe(false);

    const italk = fakeEnv({ 'FROM tenants WHERE id': { id: 'zupa-a', status: 'onboarding' } });
    (italk.env as unknown as { MONERIUM_PROFILE_ID: string }).MONERIUM_PROFILE_ID = 'prof-b';
    expect((await call(italk.env, 'PUT', '/admin/api/tenants/zupa-a/rail', body)).status).toBe(409);
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
