import { describe, expect, it } from 'vitest';

import {
  getTenantRail,
  legacyRail,
  railFromRow,
  type TenantRailRow,
} from '../src/tenants/rail';
import type { Env } from '../src/types';

const ITALK_SAFE = '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e';
const ZUPA_SAFE = '0x1111111111111111111111111111111111111111';

function env(over: Partial<Env> = {}): Env {
  return {
    DEFAULT_TENANT_ID: 'italk',
    MONERIUM_BASE_URL: 'https://api.monerium.app',
    MONERIUM_CLIENT_ID: 'italk-client',
    MONERIUM_CLIENT_SECRET: 'italk-secret',
    MONERIUM_WEBHOOK_SECRET: 'whsec_italk',
    MONERIUM_PROFILE_ID: '',
    SAFE_ADDRESS: ITALK_SAFE,
    ROLES_MODIFIER_ADDRESS: '0x330347d656b1a5DF972f758DE1E25E99ec36762c',
    ROLE_KEY: '0xrole',
    ROUTER_PRIVATE_KEY: '0xitalk-router',
    GNOSIS_RPC_URL: '',
    EURE_CONTRACT: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
    PAYMENT_REGISTRY_ADDRESS: '',
    MULTISEND_ADDRESS: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
    MULTI_TENANT_RAIL: '1',
    ...over,
  } as unknown as Env;
}

function row(over: Partial<TenantRailRow> = {}): TenantRailRow {
  return {
    tenant_id: 'zupa-a',
    monerium_env: 'production',
    chain: 'gnosis',
    auth_kind: 'client_credentials',
    client_id: 'zupa-client',
    client_secret_enc: 'enc:client_secret',
    refresh_token_enc: null,
    profile_id: 'prof-zupa',
    receiving_safe: ZUPA_SAFE,
    roles_modifier: '0x2222222222222222222222222222222222222222',
    role_key: '0xzuparole',
    router_address: '0x3333333333333333333333333333333333333333',
    router_key_enc: 'enc:router_key',
    eure_contract: null,
    rpc_url: null,
    webhook_secret_enc: 'enc:webhook_secret',
    webhook_subscription_id: null,
    outbound_webhook_url: null,
    outbound_webhook_secret_enc: null,
    max_forward_cents: 500_000,
    verified_at: null,
    verify_report: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const fakeDecrypt = async (field: string, blob: string | null) => `plain:${field}:${blob}`;

describe('legacyRail — ITalk from env, unchanged', () => {
  it('maps every env value the rail used before ADR 0017', () => {
    const r = legacyRail(env());
    expect(r).toMatchObject({
      tenantId: 'italk',
      legacy: true,
      webhookSecret: 'whsec_italk',
      receivingSafe: ITALK_SAFE.toLowerCase(),
      monerium: {
        baseUrl: 'https://api.monerium.app',
        clientId: 'italk-client',
        clientSecret: 'italk-secret',
        profileId: null,
        tokenCacheKey: 'monerium:access_token',
      },
    });
    expect(r.signer).toMatchObject({
      safe: ITALK_SAFE,
      privateKey: '0xitalk-router',
      rpcUrl: 'https://rpc.gnosischain.com',
      multiSend: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
    });
  });
});

describe('railFromRow — a tenant never inherits ITalk config', () => {
  it('builds the tenant rail only from its own row', async () => {
    const r = await railFromRow(env(), row(), fakeDecrypt);
    expect(r).not.toBeNull();
    expect(r!.legacy).toBe(false);
    expect(r!.monerium.tokenCacheKey).toBe('monerium:access_token:zupa-a');
    expect(r!.monerium.clientSecret).toBe('plain:client_secret:enc:client_secret');
    expect(r!.monerium.profileId).toBe('prof-zupa');
    expect(r!.webhookSecret).toBe('plain:webhook_secret:enc:webhook_secret');
    expect(r!.receivingSafe).toBe(ZUPA_SAFE);
    expect(r!.signer.safe).toBe(ZUPA_SAFE);
    expect(r!.signer.privateKey).toBe('plain:router_key:enc:router_key');
    // The MultiSend/registry path is legacy-only (safe-tx/006 §1).
    expect(r!.signer.paymentRegistry).toBe('');
    expect(r!.signer.multiSend).toBe('');
    const flat = JSON.stringify(r);
    for (const italk of ['italk-client', 'italk-secret', 'whsec_italk', '0xitalk-router', ITALK_SAFE, '0xrole']) {
      expect(flat).not.toContain(italk);
    }
  });

  it('leaves signer fields empty (router disabled) rather than borrowing env', async () => {
    const r = await railFromRow(env(), row({ roles_modifier: null, role_key: null, router_key_enc: null }), fakeDecrypt);
    expect(r!.signer).toMatchObject({ rolesModifier: '', roleKey: '', privateKey: '' });
  });

  it('uses the sandbox API for monerium_env=sandbox', async () => {
    const r = await railFromRow(env(), row({ monerium_env: 'sandbox', chain: 'chiado', eure_contract: '0xchiado' }), fakeDecrypt);
    expect(r!.monerium.baseUrl).toBe('https://api.monerium.dev');
    expect(r!.signer.chain).toBe('chiado');
    expect(r!.signer.rpcUrl).toBe('https://rpc.chiadochain.net');
  });

  it.each([
    ['unknown monerium env', { monerium_env: 'staging' }],
    ['unknown chain', { chain: 'polygon' }],
    ['oauth not built yet', { auth_kind: 'oauth' }],
    ['chiado without an EURe address', { chain: 'chiado', eure_contract: null }],
  ])('refuses %s', async (_name, over) => {
    expect(await railFromRow(env(), row(over as Partial<TenantRailRow>), fakeDecrypt)).toBeNull();
  });
});

function fakeDb(r: TenantRailRow | null): { db: D1Database; queries: string[] } {
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      return { bind: () => ({ first: async () => r }) };
    },
  } as unknown as D1Database;
  return { db, queries };
}

describe('getTenantRail — fail-closed, no fallback to the default tenant', () => {
  it('returns the env rail for the default tenant without touching D1', async () => {
    const { db, queries } = fakeDb(null);
    const r = await getTenantRail(env({ DB: db }), 'italk');
    expect(r?.legacy).toBe(true);
    expect(queries).toHaveLength(0);
  });

  it('returns null for another tenant while MULTI_TENANT_RAIL is off', async () => {
    const { db, queries } = fakeDb(row());
    expect(await getTenantRail(env({ DB: db, MULTI_TENANT_RAIL: '0' }), 'zupa-a')).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('returns null for a tenant without a rail row', async () => {
    const { db } = fakeDb(null);
    expect(await getTenantRail(env({ DB: db }), 'zupa-a')).toBeNull();
  });

  it('returns null when secrets cannot be decrypted (no KEK)', async () => {
    const { db } = fakeDb(row());
    expect(await getTenantRail(env({ DB: db, TENANT_SECRETS_KEK: '' }), 'zupa-a')).toBeNull();
  });
});
