import { beforeEach, describe, expect, it, vi } from 'vitest';

/// End-to-end through the REAL forward wiring (makeForwardDeps → D1 lookups →
/// authorizeForward → forwardViaSafe) with an in-memory D1 and the signer
/// captured instead of broadcast. Proves the ADR 0017 promise in one place:
/// a payment that landed on tenant X's IBAN can only ever be signed by X's
/// rail, from X's Safe, to X's whitelist.

const signed: Array<{ signer: { safe: string; privateKey: string; rolesModifier: string }; target: string }> = [];

vi.mock('../src/router/safe', () => ({
  forwardViaSafe: async (signer: { safe: string; privateKey: string; rolesModifier: string }, args: { target: string }) => {
    signed.push({ signer, target: args.target });
    return { ok: true, txHash: '0xfeed' };
  },
  getForwardStatus: async () => 'pending',
}));

import { handleForward, makeForwardDeps } from '../src/monerium/forward';
import { legacyRail, type TenantRail } from '../src/tenants/rail';
import type { MoneriumOrder } from '../src/monerium/types';
import type { Env } from '../src/types';

const ITALK_SAFE = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';
const ITALK_PAYEE = '0x6693a7d19486dc45e9f90fd2d515d972bba2d65e';
const A_MAIN = '0xa000000000000000000000000000000000000001';
const A_PURPOSE = '0xa000000000000000000000000000000000000002';
const B_MAIN = '0xb000000000000000000000000000000000000001';
const B_PURPOSE = '0xb000000000000000000000000000000000000002';

interface Db {
  intents: Record<string, { sid: string; target_address: string; tenant_id: string | null }>;
  tenants: Record<string, { id: string; status: string; allow_sources: string }>;
  whitelist: Array<{ tenant_id: string; address: string }>;
  forwards: Array<{ order_id: string; status: string; tenant_id: string | null; error: string | null }>;
}

function fakeD1(db: Db): D1Database {
  const exec = (sql: string, args: unknown[]) => ({
    first: async () => {
      if (sql.includes('FROM payment_intents WHERE sid')) return db.intents[args[0] as string] ?? null;
      if (sql.includes('FROM tenants WHERE id')) return db.tenants[args[0] as string] ?? null;
      if (sql.includes('FROM tenant_payout_addresses')) {
        return db.whitelist.some((w) => w.tenant_id === args[0] && w.address === args[1]) ? { ok: 1 } : null;
      }
      return null; // tenant_campaigns, tenant_rail, monerium_forwards lookups, …
    },
    all: async () => ({ results: [] }),
    run: async () => {
      if (sql.includes('INSERT INTO monerium_forwards')) {
        db.forwards.push({
          order_id: args[0] as string,
          status: args[7] as string,
          error: (args[8] as string | null) ?? null,
          tenant_id: (args[12] as string | null) ?? null,
        });
        return { meta: { changes: 1, last_row_id: db.forwards.length } };
      }
      return { meta: { changes: 1, last_row_id: 0 } };
    },
  });
  return {
    prepare: (sql: string) => ({ bind: (...args: unknown[]) => exec(sql, args) }),
  } as unknown as D1Database;
}

function freshDb(): Db {
  return {
    intents: {
      'sid-of-a': { sid: 'sid-of-a', target_address: A_PURPOSE, tenant_id: 'zupa-a' },
      'sid-of-b': { sid: 'sid-of-b', target_address: B_PURPOSE, tenant_id: 'zupa-b' },
      'sid-italk': { sid: 'sid-italk', target_address: ITALK_PAYEE, tenant_id: 'italk' },
    },
    tenants: {
      italk: { id: 'italk', status: 'active', allow_sources: '[]' },
      'zupa-a': { id: 'zupa-a', status: 'active', allow_sources: '[]' },
      'zupa-b': { id: 'zupa-b', status: 'active', allow_sources: '[]' },
    },
    whitelist: [
      { tenant_id: 'italk', address: ITALK_PAYEE },
      { tenant_id: 'zupa-a', address: A_PURPOSE },
      { tenant_id: 'zupa-b', address: B_PURPOSE },
    ],
    forwards: [],
  };
}

function env(db: Db): Env {
  return {
    DB: fakeD1(db),
    DEFAULT_TENANT_ID: 'italk',
    MULTI_TENANT_RAIL: '1',
    SAFE_ADDRESS: ITALK_SAFE,
    ROLES_MODIFIER_ADDRESS: '0x330347d656b1a5df972f758de1e25e99ec36762c',
    ROLE_KEY: '0xitalkrole',
    ROUTER_PRIVATE_KEY: '0xitalk-router-key',
    EURE_CONTRACT: '0x420ca0f9b9b604ce0fd9c18ef134c705e5fa3430',
  } as unknown as Env;
}

function tenantRail(id: 'zupa-a' | 'zupa-b'): TenantRail {
  const main = id === 'zupa-a' ? A_MAIN : B_MAIN;
  return {
    tenantId: id,
    legacy: false,
    monerium: { baseUrl: '', clientId: '', clientSecret: '', profileId: `prof-${id}`, tokenCacheKey: '' },
    webhookSecret: 'whsec_x',
    receivingSafe: main,
    signer: {
      chain: 'gnosis',
      rpcUrl: '',
      eureContract: '0xeure',
      safe: main,
      rolesModifier: `${id}-roles`,
      roleKey: `${id}-role`,
      privateKey: `${id}-router-key`,
      paymentRegistry: '',
      multiSend: '',
    },
    maxForwardCents: null,
    outboundWebhook: null,
  };
}

function order(memo: string, address: string): MoneriumOrder {
  return { id: 'ord-1', kind: 'issue', state: 'processed', amount: '25.00', currency: 'eur', memo, address } as MoneriumOrder;
}

function deps(e: Env, rail: TenantRail) {
  const d = makeForwardDeps(e, rail);
  d.pollConfirmation = async () => 'timeout';
  d.emitBlocked = async () => {};
  d.alert = async () => {};
  return d;
}

beforeEach(() => {
  signed.length = 0;
});

describe('tenant isolation through the real forward wiring', () => {
  it("signs tenant A's forward with A's router, from A's Safe, to A's purpose Safe", async () => {
    const db = freshDb();
    const e = env(db);
    await handleForward(deps(e, tenantRail('zupa-a')), order(`mpt:${A_PURPOSE}?sid=sid-of-a`, A_MAIN));
    expect(signed).toEqual([
      { signer: expect.objectContaining({ safe: A_MAIN, privateKey: 'zupa-a-router-key', rolesModifier: 'zupa-a-roles' }), target: A_PURPOSE },
    ]);
    expect(db.forwards[0]).toMatchObject({ status: 'pending', tenant_id: 'zupa-a' });
  });

  it("a payment to A's IBAN carrying B's sid is parked — no signature by anyone", async () => {
    const db = freshDb();
    await handleForward(deps(env(db), tenantRail('zupa-a')), order(`mpt:${B_PURPOSE}?sid=sid-of-b`, A_MAIN));
    expect(signed).toHaveLength(0);
    expect(db.forwards).toEqual([
      { order_id: 'ord-1', status: 'blocked', error: 'not_whitelisted:tenant_mismatch', tenant_id: 'zupa-a' },
    ]);
  });

  it("a payment to A's IBAN carrying an ITalk sid is parked", async () => {
    const db = freshDb();
    await handleForward(deps(env(db), tenantRail('zupa-a')), order(`mpt:${ITALK_PAYEE}?sid=sid-italk`, A_MAIN));
    expect(signed).toHaveLength(0);
    expect(db.forwards[0]).toMatchObject({ status: 'blocked', error: 'not_whitelisted:tenant_mismatch' });
  });

  it("a payment to ITalk's IBAN carrying A's sid is parked — ITalk never pays A's Safe", async () => {
    const db = freshDb();
    const e = env(db);
    await handleForward(deps(e, legacyRail(e)), order(`mpt:${A_PURPOSE}?sid=sid-of-a`, ITALK_SAFE));
    expect(signed).toHaveLength(0);
    expect(db.forwards[0]).toMatchObject({ status: 'blocked', error: 'not_whitelisted:tenant_mismatch', tenant_id: 'italk' });
  });

  it("B's rail never signs with A's key, even for an identical memo shape", async () => {
    const db = freshDb();
    await handleForward(deps(env(db), tenantRail('zupa-b')), order(`mpt:${B_PURPOSE}?sid=sid-of-b`, B_MAIN));
    expect(signed).toHaveLength(1);
    expect(signed[0].signer.privateKey).toBe('zupa-b-router-key');
    expect(signed[0].signer.safe).toBe(B_MAIN);
  });

  it('ITalk keeps signing with the env router, as before', async () => {
    const db = freshDb();
    const e = env(db);
    await handleForward(deps(e, legacyRail(e)), order(`mpt:${ITALK_PAYEE}?sid=sid-italk`, ITALK_SAFE));
    expect(signed).toHaveLength(1);
    expect(signed[0].signer).toMatchObject({ safe: ITALK_SAFE, privateKey: '0xitalk-router-key' });
    expect(signed[0].target).toBe(ITALK_PAYEE);
  });

  it("parks when Monerium minted A's payment to an address other than A's main Safe", async () => {
    const db = freshDb();
    await handleForward(deps(env(db), tenantRail('zupa-a')), order(`mpt:${A_PURPOSE}?sid=sid-of-a`, A_PURPOSE));
    expect(signed).toHaveLength(0);
    expect(db.forwards[0]).toMatchObject({ status: 'blocked', error: 'not_whitelisted:mint_address_mismatch' });
  });
});
