import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { SIMULATE_SEPA_IN_MUTATION, SWAN_GRAPHQL_URL, SWAN_OAUTH_URL, SWAN_TESTING_URL } from '../src/providers/swan/client';
import { pickCreditorIban } from '../src/providers/swan/sandboxTransfer';
import { encryptSecret, importKek } from '../src/tenants/secrets';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// "Simuliraj uplatu (Swan)" on the checkout of a tenant with a Swan sandbox
/// account: the Testing API books a SEPA Instant credit with the intent's
/// amount and reference; nothing on our side is simulated.

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const PROJECT = '0xabc3000000000000000000000000000000ef8e00';
const VIBAN = 'FR7699999002002131653013357';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const BASE = 'https://mpt.domovina.ai';

function kv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
  };
}

interface Opts { simulate?: 'ok' | 'forbidden'; registeredIban?: string | null; environment?: 'sandbox' | 'live' }

async function setup(o: Opts = {}) {
  const { db, raw } = migratedD1();
  const kek = await importKek(KEK);
  for (const id of ['sbx-swan', 'no-swan']) {
    raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, sandbox, created_at, updated_at)
                 VALUES (?, ?, 'active', '[]', ?, 'EE11 7863 3891 6150 7282', 1, 0, 0)`).run(id, id, id);
  }
  raw.prepare(`INSERT INTO receiving_accounts (tenant_id, provider, mode, iban, environment, external_account_id, client_id,
                 client_secret_enc, active, created_at)
               VALUES ('sbx-swan', 'swan', 'fiat_notify', ?, ?, 'acc-1', 'cid', ?, 1, 0)`)
    .run(o.registeredIban ?? null, o.environment ?? 'sandbox', await encryptSecret(kek, 'sbx-swan', 'client_secret', 'cs'));
  const t = Math.floor(Date.now() / 1000);
  for (const [sid, tenant, state] of [
    ['swansid00001', 'sbx-swan', 'pending'],
    ['swansid00002', 'no-swan', 'pending'],
    ['swansid00003', 'sbx-swan', 'paid'],
  ]) {
    raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id)
                 VALUES (?, ?, 1234, 'EUR', ?, ?, ?, ?)`).run(sid, PROJECT, state, t, t + 900, tenant);
  }
  const env = {
    DB: db, TOKEN_CACHE: kv(), DEFAULT_TENANT_ID: 'italk', MULTI_TENANT_RAIL: '1', TENANT_SECRETS_KEK: KEK,
    INTENT_REQUIRE_TENANT_KEY: '0', ALLOWED_ORIGINS: '',
  } as unknown as Env;
  const simulated: Array<{ auth: string; input: Record<string, unknown> }> = [];
  const accountReads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === SWAN_OAUTH_URL) return Response.json({ access_token: 'tok', expires_in: 3600 });
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    if (url === SWAN_GRAPHQL_URL.sandbox && body.query.includes('account(accountId')) {
      accountReads.push(String(body.variables.id));
      return Response.json({ data: { account: {
        IBAN: 'FR7699999001001111111111111', name: 'Swan probe račun', holder: { info: { name: 'Swan Probe d.o.o.' } },
        virtualIbanEntries: { edges: [{ node: { IBAN: 'FR7600000000000000000000000', status: 'Canceled' } }, { node: { IBAN: VIBAN, status: 'Enabled' } }] },
      } } });
    }
    if (url === SWAN_TESTING_URL) {
      simulated.push({ auth: (init.headers as Record<string, string>).authorization, input: body.variables.input as Record<string, unknown> });
      return Response.json({ data: { simulateIncomingSepaCreditTransferReception: o.simulate === 'forbidden'
        ? { __typename: 'ForbiddenRejection', message: 'nope' }
        : { __typename: 'SimulateIncomingSepaCreditTransferReceptionSuccessPayload', transactionId: 'bosci_tx1' } } });
    }
    return new Response('unexpected', { status: 500 });
  }));
  return { env, simulated, accountReads };
}

afterEach(() => vi.unstubAllGlobals());

const transfer = (env: Env, sid: string) =>
  worker.fetch(new Request(`${BASE}/api/intents/${sid}/swan-sandbox-transfer`, { method: 'POST' }), env, ctx);

describe('POST /api/intents/:sid/swan-sandbox-transfer', () => {
  it('asks Swan for an instant SEPA credit of the intent amount, reference as label, on the enabled vIBAN', async () => {
    const { env, simulated, accountReads } = await setup();
    const r = await transfer(env, 'swansid00001');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, amount_eur: '12.34', iban: VIBAN, swan_transaction_id: 'bosci_tx1' });
    expect(accountReads).toEqual(['acc-1']);
    expect(simulated).toHaveLength(1);
    expect(simulated[0].auth).toBe('Bearer tok');
    expect(simulated[0].input).toMatchObject({
      amount: { value: '12.34', currency: 'EUR' },
      creditorIban: VIBAN,
      creditorName: 'Swan Probe d.o.o.',
      debtorIban: 'HR1210010051863000160',
      isInstant: true,
    });
    expect(String(simulated[0].input.label)).toContain('sid=swansid00001');
  });

  it('uses the IBAN registered on the receiving account without asking Swan for it', async () => {
    const { env, simulated, accountReads } = await setup({ registeredIban: 'FR7612345000000000000000000' });
    expect((await transfer(env, 'swansid00001')).status).toBe(200);
    expect(accountReads).toEqual([]);
    expect(simulated[0].input.creditorIban).toBe('FR7612345000000000000000000');
  });

  it('a second click within the lock window does not book twice', async () => {
    const { env, simulated } = await setup();
    expect((await transfer(env, 'swansid00001')).status).toBe(200);
    expect((await transfer(env, 'swansid00001')).status).toBe(429);
    expect(simulated).toHaveLength(1);
  });

  it('tenant without a Swan sandbox account, unknown sid, or live account: 404', async () => {
    const { env, simulated } = await setup();
    expect((await transfer(env, 'swansid00002')).status).toBe(404);
    expect((await transfer(env, 'nosuchsid000')).status).toBe(404);
    const live = await setup({ environment: 'live' });
    expect((await transfer(live.env, 'swansid00001')).status).toBe(404);
    expect(simulated).toHaveLength(0);
    expect(live.simulated).toHaveLength(0);
  });

  it('a settled intent is 409', async () => {
    const { env, simulated } = await setup();
    expect((await transfer(env, 'swansid00003')).status).toBe(409);
    expect(simulated).toHaveLength(0);
  });

  it('a Swan rejection is 502 and releases the lock', async () => {
    const { env } = await setup({ simulate: 'forbidden' });
    const r = await transfer(env, 'swansid00001');
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: 'swan_simulate_failed' });
    expect(await env.TOKEN_CACHE.get('swan-sandbox-transfer:swansid00001')).toBeNull();
  });
});

describe('checkout page with a Swan sandbox account', () => {
  it('the primary simulate button goes through Swan', async () => {
    const { env } = await setup();
    const html = await (await worker.fetch(new Request(`${BASE}/checkout/swansid00001`), env, ctx)).text();
    expect(html).toContain('onclick="simulateSwan()"');
    expect(html).not.toContain(`onclick="simulate('paid')"`);
    const other = await (await worker.fetch(new Request(`${BASE}/checkout/swansid00002`), env, ctx)).text();
    expect(other).toContain(`onclick="simulate('paid')"`);
    expect(other).not.toContain('onclick="simulateSwan()"');
  });
});

describe('SIMULATE_SEPA_IN_MUTATION', () => {
  // Swan's payload union is Success | ForbiddenRejection; an inline fragment
  // on the Rejection interface fails validation ("invalid type: 'Rejection'").
  it('spreads only on members of the payload union', () => {
    expect(SIMULATE_SEPA_IN_MUTATION).toContain('... on ForbiddenRejection { message }');
    expect(SIMULATE_SEPA_IN_MUTATION).not.toMatch(/on Rejection\b/);
  });
});

describe('pickCreditorIban', () => {
  it('registered IBAN, then first enabled vIBAN, then the account IBAN', () => {
    expect(pickCreditorIban('X', { iban: 'A', virtualIbans: ['V'] })).toBe('X');
    expect(pickCreditorIban(null, { iban: 'A', virtualIbans: ['V'] })).toBe('V');
    expect(pickCreditorIban(null, { iban: 'A', virtualIbans: [] })).toBe('A');
    expect(pickCreditorIban(null, null)).toBeNull();
  });
});
