import { describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { readFileSync } from 'node:fs';

// @ts-expect-error — plain .mjs shared with the setup dApp and tools/funding
import * as ps from '../safe-tx/lib/project-safe.mjs';
import { addProject, deployerAddress, deployerKey, type ProjectChain, type ProjectMonerium } from '../src/setup/projects';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// proxyCreationCode() of the canonical factories, read 17. 10. 2026.
/// (1.3.0 on Chiado, 1.5.0 on Gnosis).
const CREATION = JSON.parse(readFileSync(new URL('./fixtures/proxyCreationCode.json', import.meta.url), 'utf8')) as Record<string, Hex>;
const TENANT = 'italk-sandbox';
const MAIN = '0xe2e21755d3F576F090Ecda1D830F3fDA865f37fF';
const DOMOVINA_AI = '0xFbAf41F513cDbF0438b2E339C25A8Fdc949f9722';

describe('project Safe plan (ADR 0027)', () => {
  it('project:domovinatv-domovina-ai on Chiado = the Safe funding-init deployed on 17. 10. 2026.', () => {
    const plan = ps.projectSafePlan({
      version: '1.3.0', owners: ps.DEFAULT_OWNERS, threshold: 2, saltLabel: 'project:domovinatv-domovina-ai', creationCode: CREATION['1.3.0'],
    });
    expect(plan.address).toBe(DOMOVINA_AI);
    expect(plan.factory).toBe(ps.SAFE_CONTRACTS['1.3.0'].factory);
  });

  it('owners, threshold, salt and the pre-signed link each change the address', () => {
    const base = { version: '1.3.0', owners: ps.DEFAULT_OWNERS, threshold: 2, saltLabel: 'project:x', creationCode: CREATION['1.3.0'] };
    const a = ps.projectSafePlan(base).address;
    expect(ps.projectSafePlan({ ...base, threshold: 3 }).address).not.toBe(a);
    expect(ps.projectSafePlan({ ...base, saltLabel: 'project:y' }).address).not.toBe(a);
    expect(ps.projectSafePlan({ ...base, owners: ps.DEFAULT_OWNERS.slice(0, 2) }).address).not.toBe(a);
    expect(ps.projectSafePlan({ ...base, preSignLink: false }).address).not.toBe(a);
    expect(ps.projectSafePlan({ ...base, version: '1.5.0', creationCode: CREATION['1.5.0'] }).address).not.toBe(a);
  });

  it('1.5.0 (Gnosis) has a SignMessageLib, so prod Safes are born linked too', () => {
    expect(ps.SAFE_VERSION).toEqual({ gnosis: '1.5.0', chiado: '1.3.0' });
    expect(ps.linkSignatureSetupCall(ps.SAFE_CONTRACTS['1.5.0']).to).toBe('0x4FfeF8222648872B3dE295Ba1e49110E61f5b5aa');
  });

  it('refuses bad owners and thresholds', () => {
    const o = ps.DEFAULT_OWNERS;
    expect(() => ps.checkOwners([], 1)).toThrow(/barem/);
    expect(() => ps.checkOwners(['0x12'], 1)).toThrow(/EVM/);
    expect(() => ps.checkOwners([o[0], o[0].toLowerCase()], 1)).toThrow(/dvaput/);
    expect(() => ps.checkOwners(o, 0)).toThrow(/prag/);
    expect(() => ps.checkOwners(o, 4)).toThrow(/prag/);
    expect(() => ps.checkOwners(o, 2)).not.toThrow();
  });
});

describe('deployer key', () => {
  const k = 'ab'.repeat(32);
  it('is trimmed, 0x-prefixed and per chain; malformed = no deployer', () => {
    expect(deployerKey({ CHIADO_DEPLOYER_PRIVATE_KEY: `  ${k}\n` } as unknown as Env, 'chiado')).toBe(`0x${k}`);
    expect(deployerKey({ CHIADO_DEPLOYER_PRIVATE_KEY: `0x${k}` } as unknown as Env, 'gnosis')).toBeNull();
    expect(deployerKey({ GNOSIS_DEPLOYER_PRIVATE_KEY: '0x1234' } as unknown as Env, 'gnosis')).toBeNull();
    expect(deployerAddress({} as Env, 'chiado')).toBeNull();
  });
});

describe('POST …/projects (addProject)', () => {
  function env(): { env: Env; raw: ReturnType<typeof migratedD1>['raw'] } {
    const { db, raw } = migratedD1();
    raw.prepare(
      `INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, bic, created_at, updated_at)
       VALUES (?, 'ITalk sandbox', 'active', '[]', 'ITalk d.o.o.', 'EE514996096977407661', NULL, 0, 0)`,
    ).run(TENANT);
    return { env: { DB: db } as unknown as Env, raw };
  }

  /// A fake Chiado: `deployed` holds addresses with code; deploy() adds one.
  function chain(opts: { deployer?: boolean; signed?: boolean; owners?: string[]; threshold?: number } = {}) {
    const deployed = new Set<string>();
    const calls: { factory: Address; args: readonly unknown[] }[] = [];
    const c: ProjectChain = {
      chain: 'chiado',
      version: '1.3.0',
      creationCode: async () => CREATION['1.3.0'],
      hasCode: async (a) => deployed.has(a.toLowerCase()),
      isLinkSigned: async () => opts.signed ?? true,
      readOwners: async () => ({ owners: (opts.owners ?? ps.DEFAULT_OWNERS) as Address[], threshold: opts.threshold ?? 2 }),
      ...(opts.deployer === false ? {} : {
        deployer: {
          address: '0x9915000000000000000000000000000000004c65' as Address,
          deploy: async (factory: Address, args: readonly unknown[]) => {
            calls.push({ factory, args });
            deployed.add(DOMOVINA_AI.toLowerCase());
            return '0xdeadbeef' as Hex;
          },
        },
      }),
    };
    return { c, deployed, calls };
  }

  function monerium(opts: { linked?: boolean; fail?: boolean } = {}) {
    const links: { profile: string; a: string; chain: string }[] = [];
    const m: ProjectMonerium = {
      sandbox: true,
      profileId: async () => 'prof-sb',
      findAddress: async () => (opts.linked ? { chains: ['chiado'] } : null),
      link: async (profile, a, ch) => {
        if (opts.fail) throw new Error('Monerium /addresses → 422: signature');
        links.push({ profile, a, chain: ch });
        return { state: 'linked' };
      },
    };
    return { m, links };
  }

  const input = { campaign_id: 'domovinatv-domovina-ai', label: 'domovina.ai' };

  it('deploys with the Worker deployer, links in Monerium, writes campaign + whitelist + audit', async () => {
    const { env: e, raw } = env();
    const ch = chain();
    const mo = monerium();
    const r = await addProject(e, { tenantId: TENANT, mainSafe: MAIN, input, actor: 'ms@ff.hr' }, { chain: ch.c, monerium: mo.m });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, safe_address: DOMOVINA_AI.toLowerCase(), deploy_tx: '0xdeadbeef', monerium: { state: 'linked', already: false } });
    expect(ch.calls).toHaveLength(1);
    expect(ch.calls[0].factory).toBe(ps.SAFE_CONTRACTS['1.3.0'].factory);
    expect(mo.links).toEqual([{ profile: 'prof-sb', a: DOMOVINA_AI, chain: 'chiado' }]);
    expect(String((r.body as { monerium_name: { snippet: string } }).monerium_name.snippet)).toContain('Projekt (sandbox) domovina.ai · domovinatv-domovina-ai');
    const camp = raw.prepare(`SELECT tenant_id, safe_address, label FROM tenant_campaigns WHERE campaign_id = ?`).get(input.campaign_id);
    expect(camp).toEqual({ tenant_id: TENANT, safe_address: DOMOVINA_AI.toLowerCase(), label: 'domovina.ai' });
    const wl = raw.prepare(`SELECT COUNT(*) AS n FROM tenant_payout_addresses WHERE tenant_id = ? AND address = ?`).get(TENANT, DOMOVINA_AI.toLowerCase()) as { n: number };
    expect(wl.n).toBe(1);
    const audit = raw.prepare(`SELECT action, actor FROM tenant_audit_log WHERE tenant_id = ? ORDER BY rowid`).all(TENANT);
    expect(audit).toContainEqual({ action: 'project.add', actor: 'ms@ff.hr' });
  });

  it('an existing, already linked Safe is only checked and registered (idempotent)', async () => {
    const { env: e } = env();
    const ch = chain();
    ch.deployed.add(DOMOVINA_AI.toLowerCase());
    const mo = monerium({ linked: true });
    const r = await addProject(e, { tenantId: TENANT, mainSafe: MAIN, input, actor: 'a' }, { chain: ch.c, monerium: mo.m });
    expect(r.body).toMatchObject({ ok: true, deploy_tx: null, monerium: { already: true } });
    expect(ch.calls).toHaveLength(0);
    expect(mo.links).toHaveLength(0);
  });

  it('without a Worker deployer it returns the plan for MetaMask and writes nothing', async () => {
    const { env: e, raw } = env();
    const r = await addProject(e, { tenantId: TENANT, mainSafe: MAIN, input, actor: 'a' }, { chain: chain({ deployer: false }).c, monerium: monerium().m });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'safe_not_deployed', safe_address: DOMOVINA_AI, deployer: null, factory: ps.SAFE_CONTRACTS['1.3.0'].factory });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM tenant_campaigns`).get()).toEqual({ n: 0 });
  });

  it('deploy: false never spends the Worker key', async () => {
    const { env: e } = env();
    const ch = chain();
    const r = await addProject(e, { tenantId: TENANT, mainSafe: MAIN, input: { ...input, deploy: false }, actor: 'a' }, { chain: ch.c, monerium: monerium().m });
    expect(r.body.error).toBe('safe_not_deployed');
    expect(ch.calls).toHaveLength(0);
  });

  it('fails closed: unsigned link, wrong owners, Monerium error — nothing written', async () => {
    for (const [c, m, err] of [
      [chain({ signed: false }), monerium(), 'link_not_signed'],
      [chain({ threshold: 1 }), monerium(), 'owners_mismatch'],
      [chain(), monerium({ fail: true }), 'monerium_link_failed'],
    ] as const) {
      const { env: e, raw } = env();
      const r = await addProject(e, { tenantId: TENANT, mainSafe: MAIN, input, actor: 'a' }, { chain: c.c, monerium: m.m });
      expect(r.body.error).toBe(err);
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM tenant_campaigns`).get()).toEqual({ n: 0 });
    }
  });

  it('validates input and refuses a campaign id of another tenant', async () => {
    const { env: e, raw } = env();
    const deps = { chain: chain().c, monerium: monerium().m };
    const call = (i: object) => addProject(e, { tenantId: TENANT, mainSafe: MAIN, input: i, actor: 'a' }, deps);
    expect((await call({ campaign_id: 'x y' })).body.error).toBe('invalid_campaign_id');
    expect((await call({ campaign_id: 'abc', owners: [ps.DEFAULT_OWNERS[0]] })).body.error).toBe('invalid_owners'); // owners without threshold
    expect((await call({ campaign_id: 'abc', owners: ps.DEFAULT_OWNERS, threshold: 5 })).body.error).toBe('invalid_owners');
    raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, bic, created_at, updated_at)
       VALUES ('other', 'O', 'active', '[]', 'O', 'EE514996096977407661', NULL, 0, 0)`).run();
    raw.prepare(`INSERT INTO tenant_campaigns (campaign_id, tenant_id, safe_address, label, created_at) VALUES ('taken', 'other', ?, NULL, 0)`)
      .run(getAddress(DOMOVINA_AI).toLowerCase());
    expect((await call({ campaign_id: 'taken' })).body.error).toBe('campaign_owned_by_other_tenant');
  });
});
