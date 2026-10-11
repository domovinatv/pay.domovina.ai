import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import { handleForward, makeForwardDeps, type ForwardDeps } from '../src/monerium/forward';
import { extractRoutingTarget } from '../src/monerium/sid';
import type { MoneriumOrder } from '../src/monerium/types';
import { intentResponseJson } from '../src/intents/api';
import { renderCheckoutPage } from '../src/checkout/page';
import { MIN_ROUTER_GAS_WEI, runVerify, validateRailInput, type VerifyDeps } from '../src/tenants/onboarding';
import { hashApiKey } from '../src/tenants/db';
import { directReference, intentReference, railFromRow, type TenantRail, type TenantRailRow } from '../src/tenants/rail';
import { encryptSecret, importKek } from '../src/tenants/secrets';
import type { PaymentIntentRow } from '../src/intents/db';
import type { StageResult } from '../src/intents/stage';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// Direct mode (migration 0026): the reference `<chain>:0x<project Safe> sid:<sid>`
/// makes Monerium mint straight into the project Safe. The rail only matches
/// the order to its intent — no forward, no Roles, never a signature.

const PROJECT = '0xb3438d62c7b968806a7e3d78fc4b31ee8f738720';
const MAIN = '0xe2e21755d3f576f090ecda1d830f3fda865f37ff';
const OTHER = '0x0fe72f49936158936820198d8b0af0ef509559f3';
const SID = 'abc123def456';
const TENANT = 'italk-sandbox';

function order(over: Partial<MoneriumOrder> = {}): MoneriumOrder {
  return {
    id: 'ord-direct-1',
    kind: 'issue',
    profile: 'prof-sb',
    address: PROJECT,
    chain: 'chiado',
    currency: 'eur',
    amount: '5.00',
    memo: `chiado:${PROJECT} sid:${SID}`,
    state: 'processed',
    ...over,
  } as MoneriumOrder;
}

interface Rec {
  inserts: Array<Parameters<ForwardDeps['insertForward']>[0]>;
  forwards: number;
  alerts: string[];
  settled: string[];
  blocked: string[];
}

function harness(intentTenant: string | null = TENANT): { deps: ForwardDeps; rec: Rec } {
  const rec: Rec = { inserts: [], forwards: 0, alerts: [], settled: [], blocked: [] };
  const deps: ForwardDeps = {
    authorize: {
      getIntentBySid: async (sid) => (sid === SID ? { target_address: PROJECT, tenant_id: intentTenant } : null),
      getCampaignById: async () => null,
      getTenantStatus: async () => 'active',
      isWhitelisted: async () => false,
      safeAddress: MAIN,
      defaultTenantId: 'italk',
      railTenantId: TENANT,
      requireMintAt: MAIN,
      maxForwardCents: null,
      mode: 'direct',
    },
    getForwardByOrder: async () => null,
    insertForward: async (args) => {
      rec.inserts.push(args);
      return rec.inserts.length;
    },
    updateForward: async () => {},
    forward: async () => {
      rec.forwards++;
      return { ok: true, txHash: '0xdead' as `0x${string}` };
    },
    settleNonRoutedPaid: async (a) => {
      rec.settled.push(a.sid);
      return true;
    },
    pollConfirmation: async () => 'confirmed',
    alert: async (t) => { rec.alerts.push(t); },
    audit: async () => {},
    emitBlocked: async (a) => { rec.blocked.push(a.reason); },
  };
  return { deps, rec };
}

describe('direct mode: webhook order settles its intent without a forward', () => {
  it('order minted at the intent target → settled, no forward, no mint_address_mismatch', async () => {
    const { deps, rec } = harness();
    await handleForward(deps, order());
    expect(rec.forwards).toBe(0);
    expect(rec.alerts).toEqual([]);
    expect(rec.settled).toEqual([SID]);
    expect(rec.inserts).toHaveLength(1);
    expect(rec.inserts[0]).toMatchObject({
      orderId: 'ord-direct-1', targetAddress: PROJECT, amountWei: '0', status: 'confirmed',
      error: 'direct_mint', sid: SID, memoPrefix: 'chiado',
    });
  });

  it('accepts the gnosis: prefix the same way (production)', async () => {
    const { deps, rec } = harness();
    await handleForward(deps, order({ memo: `gnosis:${PROJECT} sid:${SID}` }));
    expect(rec.settled).toEqual([SID]);
    expect(rec.forwards).toBe(0);
  });

  it.each([
    ['payer dropped the reference: minted to the main Safe', { address: MAIN, memo: `sid:${SID}` }, 'not_minted_to_target'],
    ['memo names another Safe than the intent', { memo: `chiado:${OTHER} sid:${SID}`, address: OTHER }, 'target_mismatch'],
    ['address without sid', { memo: `chiado:${PROJECT}` }, 'missing_sid'],
    ['unknown sid', { memo: `chiado:${PROJECT} sid:zzzzzzzzzzzz` }, 'unknown_sid'],
  ])('%s → parked (%s), nothing settled, nothing signed', async (_n, over, reason) => {
    const { deps, rec } = harness();
    await handleForward(deps, order(over as Partial<MoneriumOrder>));
    expect(rec.forwards).toBe(0);
    expect(rec.settled).toEqual([]);
    expect(rec.inserts[0]?.error).toBe(`not_whitelisted:${reason}`);
  });

  it("another tenant's intent → tenant_mismatch", async () => {
    const { deps, rec } = harness('italk');
    await handleForward(deps, order());
    expect(rec.settled).toEqual([]);
    expect(rec.inserts[0]?.error).toBe('not_whitelisted:tenant_mismatch');
  });

  it('a direct rail cannot sign even if asked (second lock)', async () => {
    const rail = { tenantId: TENANT, legacy: false, mode: 'direct', receivingSafe: MAIN, maxForwardCents: null,
      signer: { chain: 'chiado' } } as unknown as TenantRail;
    const deps = makeForwardDeps({ DEFAULT_TENANT_ID: 'italk' } as unknown as Env, rail);
    const r = await deps.forward({ target: PROJECT as `0x${string}`, amountWei: 1n, sessionId: SID });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^router_disabled/);
  });
});

describe('direct reference', () => {
  it('has a space after the address and parses back to the same sid', () => {
    const ref = directReference('chiado', PROJECT.toUpperCase().replace('0X', '0x'), SID);
    expect(ref).toBe(`chiado:${PROJECT} sid:${SID}`);
    const r = extractRoutingTarget(ref);
    expect(r).toMatchObject({ sid: SID, prefix: 'chiado', diagnosticTarget: PROJECT, target: null });
  });

  it('default style stays mpt:', () => {
    expect(intentReference(null, { target_address: PROJECT, sid: SID })).toBe(`mpt:${PROJECT}?sid=${SID}`);
    expect(intentReference({ mode: 'forward', chain: 'gnosis' }, { target_address: PROJECT, sid: SID }))
      .toBe(`mpt:${PROJECT}?sid=${SID}`);
  });

  const intent = {
    sid: SID, state: 'pending', amount_cents: 500, currency: 'EUR', target_address: PROJECT,
    label: 'Karta Hrvatske', metadata_json: null, tenant_id: TENANT, created_at: 0, expires_at: 900,
    paid_at: null, monerium_order_id: null, forward_tx_hash: null, amount_received_cents: null,
  } as unknown as PaymentIntentRow;
  const sepa = { beneficiaryName: 'ITalk d.o.o.', iban: 'EE514996096977407661', bic: '' };

  it('intent JSON carries it in memo and EPC; HUB3 has no sid', () => {
    const j = intentResponseJson(intent, 'https://mpt.domovina.ai', sepa, { mode: 'direct', chain: 'chiado' });
    expect(j.memo).toBe(`chiado:${PROJECT} sid:${SID}`);
    expect(String(j.epc_qr_data).split('\n')).toContain(`chiado:${PROJECT} sid:${SID}`);
    // EE IBAN → no HUB3 at all; with an HR IBAN it must still carry no sid.
    const hr = intentResponseJson(intent, 'https://x', { ...sepa, iban: 'HR1210010051863000160' }, { mode: 'direct', chain: 'chiado' });
    expect(String(hr.hub3_data)).not.toContain(SID);
    const desc = String(hr.hub3_data).split('\n')[13];
    expect(desc.length).toBeLessThanOrEqual(35);
  });

  it('checkout shows the reference with a copy button and the Revolut hint', () => {
    const html = renderCheckoutPage(intent, { stage: 'awaiting_payment' } as unknown as StageResult, sepa,
      { mode: 'direct', chain: 'chiado' });
    expect(html).toContain(`chiado:${PROJECT} sid:${SID}`);
    expect(html).toContain('Kopiraj referencu');
    expect(html).toContain('Revolut:');
    expect(html).toContain('Bez nje novac ne stiže izravno u projekt.');
    expect(html).toContain('navigator.clipboard.writeText');
  });
});

describe('direct rail config', () => {
  const base: TenantRailRow = {
    tenant_id: TENANT, monerium_env: 'sandbox', chain: 'chiado', auth_kind: 'client_credentials',
    client_id: 'cid', client_secret_enc: 'enc', refresh_token_enc: null, profile_id: 'prof-sb',
    receiving_safe: MAIN, roles_modifier: null, role_key: null, router_address: '0x2964eeb493a386ec9a249570da3a70527a74d26b',
    router_key_enc: 'enc-router', eure_contract: '0x' + '11'.repeat(20), rpc_url: null, webhook_secret_enc: 'enc-wh',
    webhook_subscription_id: 'sub', outbound_webhook_url: null, outbound_webhook_secret_enc: null,
    max_forward_cents: null, verified_at: null, verify_report: null, created_at: 0, updated_at: 0, mode: 'direct',
  };
  const decrypt = async (field: string) => `plain:${field}`;

  it('a direct rail never loads its router key', async () => {
    const r = await railFromRow({} as Env, base, decrypt);
    expect(r?.mode).toBe('direct');
    expect(r?.signer.privateKey).toBe('');
  });

  it('an unknown mode is refused, a missing one is forward', async () => {
    expect(await railFromRow({} as Env, { ...base, mode: 'yolo' }, decrypt)).toBeNull();
    const legacyRow = { ...base };
    delete legacyRow.mode;
    expect((await railFromRow({} as Env, legacyRow, decrypt))?.mode).toBe('forward');
  });

  it('PUT rail accepts mode=direct and keeps the stored mode when omitted', () => {
    const body = { client_id: 'cid', profile_id: 'prof-sb', receiving_safe: MAIN, chain: 'chiado',
      monerium_env: 'sandbox', eure_contract: '0x' + '11'.repeat(20) };
    expect(validateRailInput({ ...body, mode: 'direct' }, base)).toMatchObject({ ok: true, value: { mode: 'direct' } });
    expect(validateRailInput(body, base)).toMatchObject({ ok: true, value: { mode: 'direct' } });
    expect(validateRailInput(body, { ...base, mode: 'forward' })).toMatchObject({ ok: true, value: { mode: 'forward' } });
    expect(validateRailInput({ ...body, mode: 'x' }, base)).toEqual({ ok: false, error: 'invalid_mode' });
  });

  const verifyDeps = (over: Partial<VerifyDeps> = {}): VerifyDeps => ({
    authProfiles: async () => ['prof-sb'],
    listIbans: async () => [{ iban: 'EE514996096977407661', profile: 'prof-sb', address: MAIN, chain: 'chiado' }],
    getCode: async () => '0x6080',
    isModuleEnabled: async () => { throw new Error('must not be called'); },
    listModules: async () => { throw new Error('must not be called'); },
    avatar: async () => { throw new Error('must not be called'); },
    target: async () => { throw new Error('must not be called'); },
    balanceWei: async () => { throw new Error('must not be called'); },
    activeWhitelistCount: async () => 0,
    activeCampaignCount: async () => 1,
    ...over,
  });

  it('verify skips Roles, role key, router gas and cap; requires a campaign', async () => {
    const checks = await runVerify(verifyDeps(), { iban: 'EE51 4996 0969 7740 7661' }, base, false);
    expect(checks.map((c) => c.key)).toEqual(['monerium_profile', 'iban_linked_to_safe', 'safe_deployed', 'webhook', 'campaigns']);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    const none = await runVerify(verifyDeps({ activeCampaignCount: async () => 0 }), { iban: 'EE514996096977407661' }, base, false);
    expect(none.filter((c) => !c.ok).map((c) => c.key)).toEqual(['campaigns']);
  });

  it('forward-mode verify is unchanged', async () => {
    const checks = await runVerify(
      verifyDeps({
        isModuleEnabled: async () => true, listModules: async () => [], avatar: async () => MAIN,
        target: async () => MAIN, balanceWei: async () => MIN_ROUTER_GAS_WEI, activeWhitelistCount: async () => 1,
      }),
      { iban: 'EE514996096977407661' }, { ...base, mode: 'forward' }, true,
    );
    expect(checks.map((c) => c.key)).toEqual([
      'monerium_profile', 'iban_linked_to_safe', 'safe_deployed', 'roles_modifier', 'only_module_is_roles',
      'role_key', 'router_gas', 'webhook', 'whitelist', 'forward_cap',
    ]);
  });
});

describe('POST /api/intents on a direct tenant (real SQL)', () => {
  const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  const KEY = 'pk_' + 'cd'.repeat(24);

  async function setup(): Promise<Env> {
    const { db, raw } = migratedD1();
    const kek = await importKek(KEK);
    raw.prepare(
      `INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, bic, created_at, updated_at)
       VALUES (?, 'ITalk sandbox', 'active', '[]', 'ITalk d.o.o.', 'EE514996096977407661', NULL, 0, 0)`,
    ).run(TENANT);
    raw.prepare(`INSERT INTO tenant_api_keys (key_hash, tenant_id, kind, created_at) VALUES (?, ?, 'public', 0)`)
      .run(await hashApiKey(KEY), TENANT);
    raw.prepare(
      `INSERT INTO tenant_rail (tenant_id, monerium_env, chain, client_id, client_secret_enc, profile_id,
         receiving_safe, eure_contract, webhook_secret_enc, webhook_subscription_id, mode, created_at, updated_at)
       VALUES (?, 'sandbox', 'chiado', 'cid', ?, 'prof-sb', ?, ?, ?, 'sub', 'direct', 0, 0)`,
    ).run(
      TENANT,
      await encryptSecret(kek, TENANT, 'client_secret', 'cs'),
      MAIN,
      '0x' + '11'.repeat(20),
      await encryptSecret(kek, TENANT, 'webhook_secret', 'whsec_x'),
    );
    raw.prepare(
      `INSERT INTO tenant_campaigns (campaign_id, tenant_id, safe_address, label, created_at)
       VALUES ('domovinatv-karta-hrvatske', ?, ?, 'Karta Hrvatske', 0)`,
    ).run(TENANT, PROJECT);
    return {
      DB: db, DEFAULT_TENANT_ID: 'italk', MULTI_TENANT_RAIL: '1', TENANT_SECRETS_KEK: KEK,
      INTENT_REQUIRE_TENANT_KEY: '0', ALLOWED_ORIGINS: '',
    } as unknown as Env;
  }

  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const post = (env: Env, target: string) =>
    worker.fetch(
      new Request('https://mpt.domovina.ai/api/intents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ target_address: target, amount_eur: '5', label: 'Karta Hrvatske' }),
      }),
      env,
      ctx,
    );

  it('campaign Safe → direct reference in memo, EPC and checkout', async () => {
    const env = await setup();
    const res = await post(env, PROJECT);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, string>;
    const ref = `chiado:${PROJECT} sid:${j.sid}`;
    expect(j.memo).toBe(ref);
    expect(j.epc_qr_data).toContain(ref);
    const again = (await (await worker.fetch(new Request(`https://mpt.domovina.ai/api/intents/${j.sid}`), env, ctx)).json()) as Record<string, string>;
    expect(again.memo).toBe(ref);
    const page = await (await worker.fetch(new Request(`https://mpt.domovina.ai/checkout/${j.sid}`), env, ctx)).text();
    expect(page).toContain(ref);
    expect(page).toContain('Kopiraj referencu');
  });

  it('a Safe that is not a campaign of the tenant → 403 target_not_campaign', async () => {
    const env = await setup();
    const res = await post(env, OTHER);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'target_not_campaign' });
  });
});
