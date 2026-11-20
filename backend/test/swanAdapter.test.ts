import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import worker from '../src/index';
import { createReceivingAccount } from '../src/inflow/receivingAccounts';
import { decimalToCents } from '../src/inflow/creditEvent';
import { normalizeSwanTransaction } from '../src/providers/swan/adapter';
import { SWAN_GRAPHQL_URL, SWAN_OAUTH_URL, type SwanTransaction } from '../src/providers/swan/client';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0032 + Swan sandbox probe (docs/research/provideri/swan.md): the
/// webhook is a thin trigger, the transaction is re-read from Swan, matched by
/// the shared matcher and settled through the production settle path.

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ACCOUNT = 'b31aae63-2a8f-42ad-a537-542899518fb8';
const PROJECT = '0x' + 'ab'.repeat(20);
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function fixture(name: string): SwanTransaction {
  const j = JSON.parse(readFileSync(join(__dirname, 'fixtures/swan', name), 'utf8')) as { data: { transaction: SwanTransaction } };
  return j.data.transaction;
}
const WEBHOOK = readFileSync(join(__dirname, 'fixtures/swan/webhook-transaction-booked.json'), 'utf8');

/// Instant credit to the vIBAN, as the sandbox returned it, plus the
/// `account { id }` the adapter asks for.
function txWith(over: Partial<SwanTransaction> = {}, accountId = ACCOUNT): SwanTransaction {
  return { ...fixture('transaction-sepa-instant-in-viban.json'), account: { id: accountId }, ...over };
}

async function setup(opts: { tx?: SwanTransaction | null; webhookSecret?: string | null; intentCents?: number } = {}) {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
               VALUES ('swant', 'Swan tenant', 'active', '[]', 'MPT Probe d.o.o.', 'FR7699999001003850976461402', 0, 0)`).run();
  raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
               VALUES ('other', 'Other', 'active', '[]', 'Other', 'HR1210010051863000160', 0, 0)`).run();
  const t = Math.floor(Date.now() / 1000);
  const add = (sid: string, tenant: string, cents: number, withKey = 1) =>
    raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id, created_with_key)
                 VALUES (?, ?, ?, 'EUR', 'pending', ?, ?, ?, ?)`).run(sid, PROJECT, cents, t - 60, t + 900, tenant, withKey);
  add('swanprobe01', 'swant', opts.intentCents ?? 1234);
  add('othersid001', 'other', 1234);
  const env = {
    DB: db, DEFAULT_TENANT_ID: 'italk', MULTI_TENANT_RAIL: '1', TENANT_SECRETS_KEK: KEK,
    INTENT_REQUIRE_TENANT_KEY: '0', ALLOWED_ORIGINS: '',
  } as unknown as Env;
  await createReceivingAccount(env, {
    tenantId: 'swant', provider: 'swan', mode: 'fiat_notify', environment: 'sandbox',
    externalAccountId: ACCOUNT, clientId: 'cid', clientSecret: 'csecret', webhookSecret: opts.webhookSecret ?? null,
  });
  const graphql: Array<{ auth: string; id: string }> = [];
  const tx = opts.tx === undefined ? txWith() : opts.tx;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === SWAN_OAUTH_URL) {
      expect(String(init.body)).toContain('client_secret=csecret');
      return Response.json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url === SWAN_GRAPHQL_URL.sandbox) {
      const b = JSON.parse(String(init.body)) as { variables: { id: string } };
      graphql.push({ auth: (init.headers as Record<string, string>).authorization, id: b.variables.id });
      return Response.json({ data: { transaction: tx } });
    }
    return new Response('ok', { status: 200 }); // merchant webhooks, alerts
  }));
  return { env, raw, graphql };
}

afterEach(() => vi.unstubAllGlobals());

function post(env: Env, tenant: string, body = WEBHOOK, headers: Record<string, string> = {}) {
  return worker.fetch(
    new Request(`https://api.mpt.hr/api/swan/webhook/t/${tenant}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
    env,
    ctx,
  );
}

describe('normalizeSwanTransaction', () => {
  it('maps the sandbox instant credit to a booked sepa_inst CreditEvent', () => {
    const ev = normalizeSwanTransaction(txWith(), { id: 1, tenantId: 'swant' })!;
    expect(ev).toMatchObject({
      provider: 'swan',
      providerRef: 'bosci_2c2198a642650d5571594e9da743a757:booked',
      amountCents: 1234,
      remittance: 'sid:swanprobe01',
      endToEndId: 'E2E-SWANPROBE-01',
      receivingIban: 'FR7699999002002131653013357',
      debtorName: 'Ivan Horvat',
      debtorAccount: 'HR1210010051863000160',
      scheme: 'sepa_inst',
      finality: 'booked',
    });
  });

  it('plain SEPA to the main IBAN is scheme sepa', () => {
    const ev = normalizeSwanTransaction({ ...fixture('transaction-sepa-in-main-iban.json'), account: { id: ACCOUNT } }, { id: 1, tenantId: 'swant' })!;
    expect(ev.scheme).toBe('sepa');
    expect(ev.amountCents).toBe(500);
  });

  it('pending is notified; debit, card or non-EUR is ignored', () => {
    expect(normalizeSwanTransaction(txWith({ statusInfo: { status: 'Pending' } }), { id: 1, tenantId: 's' })?.finality).toBe('notified');
    expect(normalizeSwanTransaction(txWith({ side: 'Debit' }), { id: 1, tenantId: 's' })).toBeNull();
    expect(normalizeSwanTransaction(txWith({ type: 'CardOutDebit' }), { id: 1, tenantId: 's' })).toBeNull();
    expect(normalizeSwanTransaction(txWith({ amount: { value: '1.00', currency: 'GBP' } }), { id: 1, tenantId: 's' })).toBeNull();
    expect(normalizeSwanTransaction(txWith({ statusInfo: { status: 'Rejected' } }), { id: 1, tenantId: 's' })).toBeNull();
  });

  it('decimalToCents', () => {
    expect(decimalToCents('12.34')).toBe(1234);
    expect(decimalToCents('5')).toBe(500);
    expect(decimalToCents('0.5')).toBe(50);
    expect(decimalToCents('1.234')).toBeNull();
    expect(decimalToCents('-1')).toBeNull();
  });
});

describe('POST /api/swan/webhook/t/:tenantId', () => {
  it('re-reads the transaction, matches the sid and settles through intent_settlements (no synthetic order, S3)', async () => {
    const { env, raw, graphql } = await setup();
    const res = await post(env, 'swant');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, matched: true, sid: 'swanprobe01', by: 'sid' });
    expect(graphql).toEqual([{ auth: 'Bearer tok', id: 'bosci_faa953a6862562e3ed9493e1015cddee' }]);

    const intent = raw.prepare(`SELECT state, amount_received_cents, monerium_order_id FROM payment_intents WHERE sid = 'swanprobe01'`).get() as Record<string, unknown>;
    expect(intent).toEqual({ state: 'paid', amount_received_cents: 1234, monerium_order_id: null });
    const ev = raw.prepare(`SELECT provider, tenant_id, matched_sid, matched_by, scheme, finality, settlement_ref FROM credit_events`).all();
    expect(ev).toEqual([{
      provider: 'swan', tenant_id: 'swant', matched_sid: 'swanprobe01', matched_by: 'sid', scheme: 'sepa_inst',
      finality: 'booked', settlement_ref: 'swan_bosci_2c2198a642650d5571594e9da743a757',
    }]);
    expect(raw.prepare(`SELECT sid, provider, settlement_ref FROM intent_settlements`).all()).toEqual([
      { sid: 'swanprobe01', provider: 'swan', settlement_ref: 'swan_bosci_2c2198a642650d5571594e9da743a757' },
    ]);
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM monerium_orders`).get()).toEqual({ n: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM monerium_forwards`).get()).toEqual({ n: 0 });
  });

  it('a redelivery is deduplicated on the inbox and settles once (one intent_settlements row)', async () => {
    const { env, raw } = await setup();
    await post(env, 'swant');
    const again = await post(env, 'swant');
    expect(await again.json()).toMatchObject({ ok: true, dedup: true });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM credit_events`).get()).toEqual({ n: 1 });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM intent_settlements`).get()).toEqual({ n: 1 });
  });

  it('a transaction on another Swan account is ignored', async () => {
    const { env, raw } = await setup({ tx: txWith({}, 'someone-elses-account') });
    const res = await post(env, 'swant');
    expect(await res.json()).toMatchObject({ ok: true, ignored: 'not_this_tenant_account' });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM credit_events`).get()).toEqual({ n: 0 });
  });

  it('a sid of another tenant is never settled from this account', async () => {
    const { env, raw } = await setup({ tx: txWith({ label: 'sid:othersid001' }) });
    const res = await post(env, 'swant');
    expect(await res.json()).toMatchObject({ matched: false, note: 'sid_other_tenant: othersid001' });
    expect((raw.prepare(`SELECT state FROM payment_intents WHERE sid = 'othersid001'`).get() as { state: string }).state).toBe('pending');
  });

  it('no reference: the stray resolver finds the one open intent of that amount', async () => {
    const now = new Date().toISOString();
    const { env } = await setup({ tx: txWith({ label: 'clanarina studeni', createdAt: now, statusInfo: { status: 'Booked', bookingDate: now } }) });
    const res = await post(env, 'swant');
    expect(await res.json()).toMatchObject({ matched: true, sid: 'swanprobe01', by: 'stray' });
  });

  it('underpayment records the money but does not flip paid', async () => {
    const { env, raw } = await setup({ intentCents: 2000 });
    await post(env, 'swant');
    const i = raw.prepare(`SELECT state, amount_received_cents FROM payment_intents WHERE sid = 'swanprobe01'`).get();
    expect(i).toEqual({ state: 'pending', amount_received_cents: 1234 });
  });

  it('pending (notified) is stored but never settles', async () => {
    const { env, raw } = await setup({ tx: txWith({ statusInfo: { status: 'Pending' } }) });
    const res = await post(env, 'swant');
    expect(await res.json()).toMatchObject({ ok: true, finality: 'notified' });
    expect((raw.prepare(`SELECT state FROM payment_intents WHERE sid = 'swanprobe01'`).get() as { state: string }).state).toBe('pending');
  });

  it('with a configured secret, a wrong x-swan-secret is 401 and nothing is fetched', async () => {
    const { env, graphql } = await setup({ webhookSecret: 's3cret-value' });
    expect((await post(env, 'swant', WEBHOOK, { 'x-swan-secret': 'nope' })).status).toBe(401);
    expect((await post(env, 'swant')).status).toBe(401);
    expect(graphql).toHaveLength(0);
    expect((await post(env, 'swant', WEBHOOK, { 'x-swan-secret': 's3cret-value' })).status).toBe(200);
  });

  it('tenant without a Swan account → 404; non-transaction events are acknowledged', async () => {
    const { env } = await setup();
    expect((await post(env, 'other')).status).toBe(404);
    const res = await post(env, 'swant', JSON.stringify({ eventType: 'Account.Updated', resourceId: 'x' }));
    expect(await res.json()).toMatchObject({ ok: true, ignored: 'Account.Updated' });
  });
});
