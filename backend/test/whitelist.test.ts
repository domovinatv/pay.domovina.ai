import { describe, expect, it } from 'vitest';

import {
  authorizeForward,
  type AuthorizeDeps,
  type ForwardDecision,
} from '../src/tenants/whitelist';
import { isAddressWhitelisted, parseAllowSources } from '../src/tenants/db';
import type { RoutingTarget } from '../src/monerium/sid';
import type { Env } from '../src/types';

const PAYEE = '0x6693a7d19486dc45e9f90fd2d515d972bba2d65e';
const OTHER = '0x0fe72f49936158936820198d8b0af0ef509559f3';
const SAFE = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';

function routing(over: Partial<RoutingTarget> = {}): RoutingTarget {
  return {
    target: PAYEE,
    diagnosticTarget: PAYEE,
    sid: 'abc123def456',
    campaignId: null,
    prefix: 'mpt',
    ...over,
  };
}

function deps(over: Partial<AuthorizeDeps> = {}): AuthorizeDeps {
  return {
    getIntentBySid: async (sid) =>
      sid === 'abc123def456' ? { target_address: PAYEE, tenant_id: 'italk' } : null,
    getCampaignById: async (id) =>
      id === 'kampanja-1' ? { tenant_id: 'italk', safe_address: PAYEE } : null,
    getTenantStatus: async (id) => (id === 'italk' ? 'active' : null),
    isWhitelisted: async (_t, addr) => addr.toLowerCase() === PAYEE,
    safeAddress: SAFE,
    defaultTenantId: 'italk',
    ...over,
  };
}

async function decide(
  r: Partial<RoutingTarget> = {},
  d: Partial<AuthorizeDeps> = {},
): Promise<ForwardDecision> {
  return authorizeForward(deps(d), routing(r));
}

describe('authorizeForward — the happy path', () => {
  it('forwards when the sid binds to the intent AND the address is whitelisted', async () => {
    expect(await decide()).toEqual({ action: 'forward', tenantId: 'italk' });
  });

  it('forwards a registered campaign to its registered Safe', async () => {
    const d = await decide({ prefix: 'cmp', sid: null, campaignId: 'kampanja-1' });
    expect(d).toEqual({ action: 'forward', tenantId: 'italk' });
  });

  it('compares addresses case-insensitively on both sides', async () => {
    const d = await decide(
      { target: PAYEE.toUpperCase().replace('0X', '0x') },
      { getIntentBySid: async () => ({ target_address: PAYEE.toUpperCase(), tenant_id: 'italk' }) },
    );
    expect(d.action).toBe('forward');
  });

  it('falls back to the default tenant for pre-migration intents', async () => {
    const d = await decide({}, {
      getIntentBySid: async () => ({ target_address: PAYEE, tenant_id: null }),
    });
    expect(d).toEqual({ action: 'forward', tenantId: 'italk' });
  });
});

describe('authorizeForward — fail-closed refusals', () => {
  const park = (reason: string) => ({ action: 'park', reason });

  it('parks a memo with no address at all', async () => {
    const d = await decide({ target: null, diagnosticTarget: null, prefix: null });
    expect(d).toMatchObject(park('no_routing_target'));
  });

  it('parks a bare 0x / gnosis: memo as unroutable, even though an address was seen', async () => {
    const d = await decide({ target: null, diagnosticTarget: PAYEE, prefix: 'gnosis' });
    expect(d).toMatchObject(park('unroutable_prefix'));
  });

  it('parks mpt: without a sid', async () => {
    expect(await decide({ sid: null })).toMatchObject(park('missing_sid'));
  });

  it('parks a sid that names no intent', async () => {
    expect(await decide({ sid: 'nepostojeci1' })).toMatchObject(park('unknown_sid'));
  });

  it('parks when the memo address differs from the intent target (reference tampering)', async () => {
    expect(await decide({ target: OTHER })).toMatchObject(park('target_mismatch'));
  });

  it('parks cmp: without a campaign id', async () => {
    const d = await decide({ prefix: 'cmp', sid: null, campaignId: null });
    expect(d).toMatchObject(park('missing_campaign_id'));
  });

  it('parks an unregistered campaign', async () => {
    const d = await decide({ prefix: 'cmp', sid: null, campaignId: 'nepoznata' });
    expect(d).toMatchObject(park('unknown_campaign'));
  });

  it('parks a campaign pointed at a Safe other than the registered one', async () => {
    const d = await decide({ prefix: 'cmp', sid: null, campaignId: 'kampanja-1', target: OTHER });
    expect(d).toMatchObject(park('target_mismatch'));
  });

  it('parks a correctly bound intent whose address is NOT whitelisted', async () => {
    const d = await decide(
      { target: OTHER },
      { getIntentBySid: async () => ({ target_address: OTHER, tenant_id: 'italk' }) },
    );
    expect(d).toMatchObject({ action: 'park', reason: 'not_whitelisted', tenantId: 'italk' });
  });

  it('parks when the tenant is suspended', async () => {
    const d = await decide({}, { getTenantStatus: async () => 'suspended' });
    expect(d).toMatchObject(park('tenant_suspended'));
  });

  it('parks when the tenant row is gone', async () => {
    const d = await decide({}, { getTenantStatus: async () => null });
    expect(d).toMatchObject(park('tenant_unknown'));
  });

  it('never forwards on a prefix the parser should not have routed', async () => {
    // Defensive: target set but prefix is gnosis — must not fall through.
    const d = await decide({ prefix: 'gnosis' });
    expect(d).toMatchObject(park('unroutable_prefix'));
  });
});

describe('authorizeForward — self-target no-op', () => {
  it('is a no-op (not a forward) when the bound target is the Safe itself', async () => {
    const d = await decide(
      { target: SAFE },
      {
        getIntentBySid: async () => ({ target_address: SAFE, tenant_id: 'italk' }),
        // Safe is deliberately NOT on the whitelist — no value leaves.
        isWhitelisted: async () => false,
      },
    );
    expect(d).toEqual({ action: 'self_noop', tenantId: 'italk' });
  });

  it('still requires the binding — an unbound Safe memo parks', async () => {
    const d = await decide(
      { target: SAFE, sid: 'nepostojeci1' },
      { isWhitelisted: async () => false },
    );
    expect(d).toMatchObject({ action: 'park', reason: 'unknown_sid' });
  });
});

// ---------------------------------------------------------------------------
// isAddressWhitelisted against a fake D1 — covers the SQL-level semantics
// (case-insensitivity, revoked rows, dynamic sources) that the pure decision
// function above delegates away.
// ---------------------------------------------------------------------------

interface FakeRows {
  staticAddresses: Array<{ tenant: string; address: string; revoked: boolean }>;
  tenant: { id: string; status: string; allow_sources: string } | null;
  walletSafes: string[];
}

function fakeEnv(rows: FakeRows): Env {
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => {
        if (sql.includes('FROM tenant_payout_addresses')) {
          const [tenant, addr] = args as [string, string];
          const hit = rows.staticAddresses.find(
            (r) => r.tenant === tenant && r.address.toLowerCase() === addr && !r.revoked,
          );
          return hit ? { ok: 1 } : null;
        }
        if (sql.includes('FROM tenants')) {
          return rows.tenant && rows.tenant.id === args[0] ? rows.tenant : null;
        }
        if (sql.includes('wallet_registry')) {
          const addr = String(args[0]).toLowerCase();
          return rows.walletSafes.some((s) => s.toLowerCase() === addr) ? { ok: 1 } : null;
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    }),
  });
  return { DB: { prepare } } as unknown as Env;
}

const activeTenant = { id: 'italk', status: 'active', allow_sources: '["wallet_registry"]' };

describe('isAddressWhitelisted', () => {
  it('allows an address on the static list', async () => {
    const env = fakeEnv({
      staticAddresses: [{ tenant: 'italk', address: PAYEE, revoked: false }],
      tenant: activeTenant,
      walletSafes: [],
    });
    expect(await isAddressWhitelisted(env, 'italk', PAYEE)).toBe(true);
  });

  it('is case-insensitive on the input', async () => {
    const env = fakeEnv({
      staticAddresses: [{ tenant: 'italk', address: PAYEE, revoked: false }],
      tenant: activeTenant,
      walletSafes: [],
    });
    expect(await isAddressWhitelisted(env, 'italk', PAYEE.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('refuses a revoked address', async () => {
    const env = fakeEnv({
      staticAddresses: [{ tenant: 'italk', address: PAYEE, revoked: true }],
      tenant: activeTenant,
      walletSafes: [],
    });
    expect(await isAddressWhitelisted(env, 'italk', PAYEE)).toBe(false);
  });

  it('does not leak one tenant’s address to another tenant', async () => {
    const env = fakeEnv({
      staticAddresses: [{ tenant: 'drugi', address: PAYEE, revoked: false }],
      tenant: { id: 'italk', status: 'active', allow_sources: '[]' },
      walletSafes: [],
    });
    expect(await isAddressWhitelisted(env, 'italk', PAYEE)).toBe(false);
  });

  it('allows a self-registered wallet Safe when the dynamic source is enabled', async () => {
    const env = fakeEnv({ staticAddresses: [], tenant: activeTenant, walletSafes: [PAYEE] });
    expect(await isAddressWhitelisted(env, 'italk', PAYEE)).toBe(true);
  });

  it('refuses the same Safe when the dynamic source is NOT enabled', async () => {
    const env = fakeEnv({
      staticAddresses: [],
      tenant: { id: 'italk', status: 'active', allow_sources: '[]' },
      walletSafes: [PAYEE],
    });
    expect(await isAddressWhitelisted(env, 'italk', PAYEE)).toBe(false);
  });

  it('refuses everything dynamic for a suspended tenant', async () => {
    const env = fakeEnv({
      staticAddresses: [],
      tenant: { id: 'italk', status: 'suspended', allow_sources: '["wallet_registry"]' },
      walletSafes: [PAYEE],
    });
    expect(await isAddressWhitelisted(env, 'italk', PAYEE)).toBe(false);
  });

  it('refuses a malformed address without touching the DB', async () => {
    const env = fakeEnv({ staticAddresses: [], tenant: activeTenant, walletSafes: [] });
    expect(await isAddressWhitelisted(env, 'italk', 'not-an-address')).toBe(false);
    expect(await isAddressWhitelisted(env, 'italk', '0x1234')).toBe(false);
  });
});

describe('parseAllowSources', () => {
  it('keeps known sources and drops unknown ones', () => {
    expect(parseAllowSources('["wallet_registry","magic"]')).toEqual(['wallet_registry']);
  });

  it('returns an empty list for junk, so an unparsable column can never widen access', () => {
    expect(parseAllowSources('not json')).toEqual([]);
    expect(parseAllowSources('{"wallet_registry":true}')).toEqual([]);
    expect(parseAllowSources(null)).toEqual([]);
  });
});
