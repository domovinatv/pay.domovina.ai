import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { createReceivingAccount } from '../src/inflow/receivingAccounts';
import { computeStage, type StageOrder } from '../src/intents/stage';
import { SWAN_GRAPHQL_URL, SWAN_OAUTH_URL, type SwanTransaction } from '../src/providers/swan/client';
import { intentReference } from '../src/tenants/rail';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// Migration 0035: an intent carries its inflow provider. A Swan intent is
/// plain SEPA onto the tenant's own account: no target address, no EURe, a
/// `sid:` reference, the Swan IBAN on the QR, a two-step timeline.

const HOST = 'https://mpt.domovina.ai';
const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const SWAN_IBAN = 'FR7699999002002131653013357';
const MONERIUM_IBAN = 'EE11 7863 3891 6150 7282';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

interface Opts { iban?: string | null; sandbox?: boolean }

async function setup(o: Opts = {}) {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO admin_sessions (token_hash, email, method, created_at, expires_at)
               VALUES (?, 'ops@domovina.ai', 'passkey', ?, '2999-01-01T00:00:00Z')`).run(sha('tok'), new Date().toISOString());
  for (const id of ['swant', 'plain']) {
    raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, sandbox, created_at, updated_at)
                 VALUES (?, ?, 'active', '[]', 'MPT Probe d.o.o.', ?, ?, 0, 0)`).run(id, id, MONERIUM_IBAN, o.sandbox ? 1 : 0);
  }
  const env = {
    DB: db, ADMIN_EMAILS: 'ops@domovina.ai', ADMIN_HOST: 'mpt.domovina.ai', ALLOWED_ORIGINS: HOST,
    DEFAULT_TENANT_ID: 'italk', MULTI_TENANT_RAIL: '1', TENANT_SECRETS_KEK: KEK, INTENT_REQUIRE_TENANT_KEY: '0',
    PUBLIC_API_BASE: 'https://api.mpt.hr', TOKEN_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as unknown as Env;
  await createReceivingAccount(env, {
    tenantId: 'swant', provider: 'swan', mode: 'fiat_notify', environment: 'sandbox',
    externalAccountId: 'acc-1', clientId: 'cid', clientSecret: 'cs', iban: o.iban === undefined ? SWAN_IBAN : o.iban,
  });
  const call = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`${HOST}${path}`, {
    method,
    headers: { cookie: '__Host-mpt_admin=tok', origin: HOST, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);
  return { env, raw, call };
}

afterEach(() => vi.unstubAllGlobals());

const order = (state: string): StageOrder => ({
  id: 'swan_bosci_1', state, memo: 'sid:abc', reference_number: null, tx_hashes: '[]',
  placed_at: '2026-11-18T00:00:00Z', processed_at: state === 'processed' ? '2026-11-18T00:00:01Z' : null,
  raw_json: '{}', updated_at: 1794960000,
} as StageOrder);
const intent = (provider: string | null, state: 'pending' | 'paid' | 'expired' = 'pending') => ({
  state, created_at: 1794959900, expires_at: 1794960800, paid_at: null, provider,
  amount_cents: 850, amount_received_cents: state === 'paid' ? 850 : null,
});

describe('computeStage per provider', () => {
  it('swan: payment → booked at the recipient, nothing on-chain', () => {
    const waiting = computeStage({ intent: intent('swan'), order: null, forward: null, now: 1794960000 });
    expect(waiting).toMatchObject({ stage: 'awaiting_payment', provider: 'swan', settlement: 'fiat', forward_expected: false });
    expect(waiting.steps.map((s) => [s.key, s.status])).toEqual([['payment', 'waiting'], ['settled', 'waiting']]);

    const booked = computeStage({ intent: intent('swan', 'paid'), order: order('processed'), forward: null, now: 1794960010 });
    expect(booked.stage).toBe('settled');
    expect(booked.steps.map((s) => [s.key, s.status, s.custodian])).toEqual([
      ['payment', 'proven', 'bank'], ['settled', 'proven', 'recipient'],
    ]);
    expect(booked.mint_tx_hashes).toEqual([]);

    const announced = computeStage({ intent: intent('swan'), order: order('pending'), forward: null, now: 1794960010 });
    expect(announced.stage).toBe('received_processing');
    expect(announced.steps[1].status).toBe('in_progress');

    const expired = computeStage({ intent: intent('swan', 'expired'), order: null, forward: null, now: 1794961000 });
    expect(expired.stage).toBe('expired');
  });

  it('monerium (and rows from before migration 0035) keep the mint/forward timeline', () => {
    for (const p of ['monerium', null]) {
      const s = computeStage({ intent: intent(p), order: null, forward: null, now: 1794960000 });
      expect(s).toMatchObject({ provider: 'monerium', settlement: 'onchain', forward_expected: true });
      expect(s.steps.map((x) => x.key)).toEqual(['payment', 'processing', 'minted', 'forwarding', 'settled']);
    }
  });
});

describe('intentReference', () => {
  it('a swan intent carries only the sid', () => {
    expect(intentReference(null, { target_address: '0x' + '0'.repeat(40), sid: 'abc123def456', provider: 'swan' }))
      .toBe('sid:abc123def456');
    expect(intentReference(null, { target_address: '0x' + 'ab'.repeat(20), sid: 'abc123def456', provider: 'monerium' }))
      .toBe(`mpt:0x${'ab'.repeat(20)}?sid=abc123def456`);
  });
});

describe('creating an intent', () => {
  it('admin providers endpoint: swan is the default for a tenant with a Swan account', async () => {
    const { call } = await setup();
    expect(await (await call('GET', '/admin/api/tenants/swant/providers')).json())
      .toEqual({ available: ['swan', 'monerium'], default: 'swan' });
    expect(await (await call('GET', '/admin/api/tenants/plain/providers')).json())
      .toEqual({ available: ['monerium'], default: 'monerium' });
  });

  it('swan intent: no target address, sid reference, Swan IBAN on the EPC QR', async () => {
    const { call, raw } = await setup();
    const r = await call('POST', '/admin/api/intents', { tenant_id: 'swant', amount_eur: '8.50' });
    expect(r.status).toBe(200);
    const d = (await r.json()) as Record<string, unknown>;
    expect(d).toMatchObject({
      provider: 'swan', target_address: null, memo: `sid:${d.sid as string}`, iban: SWAN_IBAN,
      beneficiary_name: 'MPT Probe d.o.o.',
    });
    expect(String(d.epc_qr_data)).toContain(SWAN_IBAN);
    expect(String(d.epc_qr_data)).not.toContain('EE11');
    expect((d.status as { settlement: string }).settlement).toBe('fiat');
    expect(raw.prepare(`SELECT provider FROM payment_intents WHERE sid = ?`).get(d.sid)).toEqual({ provider: 'swan' });
  });

  it('a Swan account without an IBAN cannot take a (non-sandbox) intent', async () => {
    const { call } = await setup({ iban: null });
    const r = await call('POST', '/admin/api/intents', { tenant_id: 'swant', amount_eur: '1.00' });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'receiving_account_without_iban' });
  });

  it('swan on a tenant without a Swan account is refused; unknown provider is 400', async () => {
    const { call } = await setup();
    const r = await call('POST', '/admin/api/intents', { tenant_id: 'plain', provider: 'swan', amount_eur: '1.00' });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'provider_not_available' });
    expect((await call('POST', '/admin/api/intents', { tenant_id: 'swant', provider: 'paypal', amount_eur: '1.00' })).status).toBe(400);
  });

  it('a sandbox tenant with a Swan account gets a swan sandbox intent', async () => {
    const { call } = await setup({ sandbox: true, iban: null });
    const r = await call('POST', '/admin/api/intents', { tenant_id: 'swant', amount_eur: '2.00' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ provider: 'swan', sandbox: true, target_address: null, iban: null });
  });
});

describe('checkout page per provider', () => {
  it('swan: no wallet, no EURe, Swan IBAN and booking copy', async () => {
    const { call, env } = await setup();
    const d = (await (await call('POST', '/admin/api/intents', { tenant_id: 'swant', amount_eur: '8.50' })).json()) as { sid: string };
    const html = await (await worker.fetch(new Request(`${HOST}/checkout/${d.sid}`), env, ctx)).text();
    expect(html).not.toContain('Primatelj wallet');
    expect(html).not.toContain('Pogledaj transakciju na Gnosisscanu');
    expect(html).not.toContain('Želim potvrdu o uplati');
    expect(html).toContain('FR76 9999 9002 0021 3165 3013 357');
    expect(html).toContain('Knjiženo na računu primatelja');
    expect(html).toContain(`sid:${d.sid}`);
    expect(html).toContain('"fiat":true');
  });
});

describe('full swan loop', () => {
  it('admin intent → Swan webhook → paid, fiat timeline', async () => {
    const { call, env, raw } = await setup();
    const d = (await (await call('POST', '/admin/api/intents', { tenant_id: 'swant', amount_eur: '12.34' })).json()) as { sid: string };
    const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures/swan/transaction-sepa-instant-in-viban.json'), 'utf8')) as {
      data: { transaction: SwanTransaction };
    };
    const tx = { ...fx.data.transaction, label: `sid:${d.sid}`, account: { id: 'acc-1' } };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === SWAN_OAUTH_URL) return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url === SWAN_GRAPHQL_URL.sandbox) return Response.json({ data: { transaction: tx } });
      return new Response('ok');
    }));
    const hook = await worker.fetch(new Request('https://api.mpt.hr/api/swan/webhook/t/swant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: readFileSync(join(__dirname, 'fixtures/swan/webhook-transaction-booked.json'), 'utf8'),
    }), env, ctx);
    expect(await hook.json()).toMatchObject({ matched: true, sid: d.sid, by: 'sid' });
    expect(raw.prepare(`SELECT state FROM payment_intents WHERE sid = ?`).get(d.sid)).toEqual({ state: 'paid' });

    const s = (await (await worker.fetch(new Request(`${HOST}/api/intents/${d.sid}`), env, ctx)).json()) as {
      status: { stage: string; settlement: string; steps: Array<{ key: string; status: string }> };
    };
    expect(s.status.stage).toBe('settled');
    expect(s.status.settlement).toBe('fiat');
    expect(s.status.steps.map((x) => x.key)).toEqual(['payment', 'settled']);
  });
});
