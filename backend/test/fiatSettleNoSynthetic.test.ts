import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import worker from '../src/index';
import { mountAdminV2 } from '../src/admin/v2/routes';
import { createReceivingAccount } from '../src/inflow/receivingAccounts';
import { encryptSecret, importKeks } from '../src/tenants/secrets';
import { FIAT_TARGET_PLACEHOLDER } from '../src/inflow/provider';
import { fiatSettlementOrder } from '../src/inflow/settleFiat';
import { SWAN_GRAPHQL_URL, SWAN_OAUTH_URL, type SwanTransaction } from '../src/providers/swan/client';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// S3 lanca „zatvaranje Swan” (ADR 0032 §4, odluke 300–): fiat namira ne piše
/// sintetski `swan_…` order ni `fiat_notify` forward. Sve što merchant vidi
/// (outbox payloadi, GET /api/intents/:sid) mora biti isto kao prije S3.
/// `fixtures/swan/merchant-payloads-pre-s3.json` je snimljen kodom s main
/// prije S3 (37e3972 + 17dd3c9) ovim istim testom uz CAPTURE_PRE_S3=1.

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ACCOUNT = 'b31aae63-2a8f-42ad-a537-542899518fb8';
const NOW = Date.parse('2026-11-20T12:00:00Z');
const REF = 'swan_bosci_2c2198a642650d5571594e9da743a757';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const WEBHOOK = readFileSync(join(__dirname, 'fixtures/swan/webhook-transaction-booked.json'), 'utf8');
const GOLDEN = join(__dirname, 'fixtures/swan/merchant-payloads-pre-s3.json');

function tx(sid: string, value = '12.34'): SwanTransaction {
  const j = JSON.parse(readFileSync(join(__dirname, 'fixtures/swan/transaction-sepa-instant-in-viban.json'), 'utf8')) as {
    data: { transaction: SwanTransaction };
  };
  const t = j.data.transaction;
  return { ...t, label: `sid:${sid}`, account: { id: ACCOUNT }, amount: { ...t.amount, value } };
}

const CASES = [
  { name: 'Swan, živi tenant', tenant: 'swant', sandbox: 0, sid: 'swanprobe01' },
  { name: 'Swan, sandbox tenant', tenant: 'sbx-swan01', sandbox: 1, sid: 'sbxswanpr01' },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup(c: (typeof CASES)[number], opts: { cents?: number; state?: 'pending' | 'expired'; paid?: string } = {}) {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at, sandbox)
               VALUES (?, 'Swan tenant', 'active', '[]', 'MPT Probe d.o.o.', 'FR7699999001003850976461402', 0, 0, ?)`).run(c.tenant, c.sandbox);
  const t = Math.floor(NOW / 1000);
  raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id, created_with_key, provider)
               VALUES (?, ?, ?, 'EUR', ?, ?, ?, ?, 1, 'swan')`)
    .run(c.sid, FIAT_TARGET_PLACEHOLDER, opts.cents ?? 1234, opts.state ?? 'pending', t - 60, t + 900, c.tenant);
  const env = {
    DB: db, DEFAULT_TENANT_ID: 'italk', MULTI_TENANT_RAIL: '1', TENANT_SECRETS_KEK: KEK,
    INTENT_REQUIRE_TENANT_KEY: '0', ALLOWED_ORIGINS: '',
  } as unknown as Env;
  const [kek] = await importKeks(env);
  const enc = (field: 'client_secret' | 'outbound_webhook_secret', v: string) => encryptSecret(kek, c.tenant, field, v);
  const hook = 'https://merchant.example/hook';
  if (c.sandbox) {
    raw.prepare(`INSERT INTO sandbox_tenants (tenant_id, outbound_webhook_url, outbound_webhook_secret_enc, created_ip_hash, created_at, last_active_at, expires_at)
                 VALUES (?, ?, ?, 'h', 0, 0, ?)`).run(c.tenant, hook, await enc('outbound_webhook_secret', 'whsec_dGVzdA=='), t + 86400);
  } else {
    raw.prepare(`INSERT INTO tenant_rail (tenant_id, monerium_env, chain, client_id, client_secret_enc, profile_id, receiving_safe,
                   outbound_webhook_url, outbound_webhook_secret_enc, eure_contract, created_at, updated_at)
                 VALUES (?, 'production', 'chiado', 'c', ?, 'p', '0x98f14ac6b2ca36abf6e5b25088e12f68c1dbb4e5', ?, ?, '0xb106ed7587365a16b6691a3d4b2a734f4e8268a2', 0, 0)`)
      .run(c.tenant, await enc('client_secret', 'x'), hook, await enc('outbound_webhook_secret', 'whsec_dGVzdA=='));
  }
  await createReceivingAccount(env, {
    tenantId: c.tenant, provider: 'swan', mode: 'fiat_notify', environment: 'sandbox', iban: 'FR7699999002002131653013357',
    externalAccountId: ACCOUNT, clientId: 'cid', clientSecret: 'csecret', webhookSecret: null,
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === SWAN_OAUTH_URL) return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (url === SWAN_GRAPHQL_URL.sandbox) return Response.json({ data: { transaction: tx(c.sid, opts.paid) } });
    return new Response('ok', { status: 200 });
  }));
  return { env, raw };
}

async function webhook(env: Env, c: (typeof CASES)[number]) {
  const res = await worker.fetch(
    new Request(`https://api.mpt.hr/api/swan/webhook/t/${c.tenant}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: WEBHOOK,
    }),
    env,
    ctx,
  );
  return (await res.json()) as Record<string, unknown>;
}

/// Što merchant vidi: outbox (id, tip, payload) i javni GET intenta.
async function merchantView(env: Env, raw: ReturnType<typeof migratedD1>['raw'], sid: string) {
  const r = await worker.fetch(new Request(`https://api.mpt.hr/api/intents/${sid}`), env, ctx);
  const outbox = (raw.prepare(`SELECT id, type, tenant_id, payload FROM webhook_outbox ORDER BY id`).all() as Array<{ payload: string }>)
    .map((o) => ({ ...o, payload: JSON.parse(o.payload) as unknown }));
  return { intent: await r.json(), outbox };
}

describe.each(CASES)('fiat namira bez sintetskog reda (S3): $name', (c) => {
  it('paid bez monerium_orders/monerium_forwards; namira je intent_settlements + credit_events', async () => {
    const { env, raw } = await setup(c);
    expect(await webhook(env, c)).toMatchObject({ ok: true, matched: true, sid: c.sid });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM monerium_orders`).get()).toEqual({ n: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM monerium_forwards`).get()).toEqual({ n: 0 });
    expect(raw.prepare(`SELECT state, monerium_order_id, forward_id, amount_received_cents FROM payment_intents WHERE sid = ?`).get(c.sid))
      .toEqual({ state: 'paid', monerium_order_id: null, forward_id: null, amount_received_cents: 1234 });
    const ce = raw.prepare(`SELECT id FROM credit_events WHERE finality = 'booked'`).get() as { id: number };
    expect(raw.prepare(`SELECT sid, provider, settlement_ref, credit_event_id FROM intent_settlements`).all())
      .toEqual([{ sid: c.sid, provider: 'swan', settlement_ref: REF, credit_event_id: ce.id }]);
  });

  it('merchant vidi isto kao prije S3 (outbox payloadi + GET intenta)', async () => {
    const { env, raw } = await setup(c);
    await webhook(env, c);
    const view = await merchantView(env, raw, c.sid);
    expect(view.outbox.map((o) => (o as unknown as { id: string }).id).sort()).toEqual([`int_${c.sid}`, `rcv_${REF}`]);
    expect((view.intent as Record<string, unknown>).monerium_order_id).toBe(REF);
    if (process.env.CAPTURE_PRE_S3) {
      const all = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>) : {};
      all[c.tenant] = view;
      writeFileSync(GOLDEN, JSON.stringify(all, null, 2) + '\n');
      return;
    }
    const golden = (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>)[c.tenant];
    expect(view).toEqual(golden);
  });

  it('admin v2 detalj: bez fiat_notify koraka i bez linka na v1 /admin/orders', async () => {
    const { env } = await setup(c);
    await webhook(env, c);
    const app = new Hono<{ Bindings: Env }>();
    mountAdminV2(app);
    const r = await app.request(`/admin/v2/payments/${c.sid}`, { headers: { cookie: `mpt_v2_mode=${c.sandbox ? 'sandbox' : 'production'}` } }, env);
    expect(r.status).toBe(200);
    const h = await r.text();
    expect(h).toContain('Uplata stigla na Swan račun');
    expect(h).toContain('Uplata (swan)');
    expect(h).not.toContain('/admin/orders/');
    expect(h).not.toContain('fiat_notify');
    expect(h).not.toContain('Proslijeđeno na odredište');
  });

  it('ponovljena dostava: inbox dedup, jedna namira, i dalje bez sintetskih redova', async () => {
    const { env, raw } = await setup(c);
    await webhook(env, c);
    expect(await webhook(env, c)).toMatchObject({ ok: true, dedup: true });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM intent_settlements`).get()).toEqual({ n: 1 });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM webhook_outbox`).get()).toEqual({ n: 2 });
    expect(raw.prepare(`SELECT (SELECT COUNT(*) FROM monerium_orders) + (SELECT COUNT(*) FROM monerium_forwards) AS n`).get()).toEqual({ n: 0 });
  });

  it('manje od traženog: underpaid, red u intent_settlements, intent ostaje pending', async () => {
    const { env, raw } = await setup(c, { cents: 5000 });
    await webhook(env, c);
    expect(raw.prepare(`SELECT state, monerium_order_id, amount_received_cents FROM payment_intents`).get())
      .toEqual({ state: 'pending', monerium_order_id: null, amount_received_cents: 1234 });
    expect(raw.prepare(`SELECT settlement_ref FROM intent_settlements`).get()).toEqual({ settlement_ref: REF });
    const types = (raw.prepare(`SELECT type FROM webhook_outbox ORDER BY type`).all() as Array<{ type: string }>).map((o) => o.type);
    expect(types).toEqual(['payment.received', 'payment.underpaid']);
    // Status: underpaid se čita iz namire, ne iz monerium_order_id.
    const r = await worker.fetch(new Request(`https://api.mpt.hr/api/intents/${c.sid}`), env, ctx);
    expect(((await r.json()) as Record<string, unknown>).monerium_order_id).toBe(REF);
  });

  it('isteklo prije uplate: late, bez paid', async () => {
    const { env, raw } = await setup(c, { state: 'expired' });
    await webhook(env, c);
    expect(raw.prepare(`SELECT state, monerium_order_id FROM payment_intents`).get()).toEqual({ state: 'expired', monerium_order_id: null });
    expect(raw.prepare(`SELECT settlement_ref FROM intent_settlements`).get()).toEqual({ settlement_ref: REF });
    const types = (raw.prepare(`SELECT type FROM webhook_outbox ORDER BY type`).all() as Array<{ type: string }>).map((o) => o.type);
    expect(types).toEqual(['payment.late', 'payment.received']);
  });
});

describe('fiat claim bez ordera (intents/db.ts)', () => {
  function env0() {
    const { db, raw } = migratedD1();
    raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, provider)
                 VALUES ('abc', ?, 500, 'pending', 0, 9999999999, 'swan')`).run(FIAT_TARGET_PLACEHOLDER);
    return { env: { DB: db } as unknown as Env, raw };
  }
  const fiat = (ref: string, cents: number) => ({
    moneriumOrderId: null, forwardId: null, forwardTxHash: null, amountReceivedCents: cents, settlementRef: ref,
  });
  const settlement = (raw: ReturnType<typeof migratedD1>['raw']) =>
    raw.prepare(`SELECT provider, settlement_ref FROM intent_settlements WHERE sid = 'abc'`).get() ?? null;

  it('underpaid pa paid na drugoj uplati: ref prati zadnju, drugi underpaid ne prolazi', async () => {
    const { markIntentPaid, markIntentUnderpaid } = await import('../src/intents/db');
    const { env, raw } = env0();
    expect(await markIntentUnderpaid(env, 'abc', fiat('swan_a', 100))).toBe(true);
    expect(settlement(raw)).toEqual({ provider: 'swan', settlement_ref: 'swan_a' });
    expect(await markIntentUnderpaid(env, 'abc', fiat('swan_b', 100))).toBe(false);
    expect(settlement(raw)).toEqual({ provider: 'swan', settlement_ref: 'swan_a' });
    expect(await markIntentPaid(env, 'abc', fiat('swan_c', 500))).toBe(true);
    expect(settlement(raw)).toEqual({ provider: 'swan', settlement_ref: 'swan_c' });
    expect(raw.prepare(`SELECT state, monerium_order_id, forward_id FROM payment_intents`).get())
      .toEqual({ state: 'paid', monerium_order_id: null, forward_id: null });
  });

  it('claim koji nije prošao ne piše namiru (changes() = 0)', async () => {
    const { markIntentLate, markIntentPaid } = await import('../src/intents/db');
    const { env, raw } = env0();
    // pending intent: late ne vrijedi, paid s premalo ne vrijedi
    expect(await markIntentLate(env, 'abc', fiat('swan_a', 500))).toBe(false);
    expect(await markIntentPaid(env, 'abc', fiat('swan_a', 499))).toBe(false);
    expect(settlement(raw)).toBeNull();
    expect(await markIntentPaid(env, 'abc', fiat('swan_a', 500))).toBe(true);
    expect(await markIntentPaid(env, 'abc', fiat('swan_b', 500))).toBe(false);
    expect(settlement(raw)).toEqual({ provider: 'swan', settlement_ref: 'swan_a' });
  });

  it('bez refa nema claima', async () => {
    const { markIntentPaid } = await import('../src/intents/db');
    const { env } = env0();
    await expect(markIntentPaid(env, 'abc', { ...fiat('x', 500), settlementRef: null })).rejects.toThrow('settle_without_ref');
  });
});

describe('JS provjere „namireno” gledaju namiru (odluka 102)', () => {
  async function underpaidFiat() {
    const { db, raw } = migratedD1();
    raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, provider, tenant_id)
                 VALUES ('swanprobe01', ?, 500, 'pending', 0, 9999999999, 'swan', 'sbx-t')`).run(FIAT_TARGET_PLACEHOLDER);
    const env = { DB: db } as unknown as Env;
    const { markIntentUnderpaid, getIntent } = await import('../src/intents/db');
    await markIntentUnderpaid(env, 'swanprobe01', {
      moneriumOrderId: null, forwardId: null, forwardTxHash: null, amountReceivedCents: 100, settlementRef: 'swan_a',
    });
    return { env, raw, intent: (await getIntent(env, 'swanprobe01'))! };
  }

  it('getIntent nosi settlement_ref; logicalIntentState = underpaid', async () => {
    const { logicalIntentState } = await import('../src/intents/intentStates');
    const { intent } = await underpaidFiat();
    expect(intent).toMatchObject({ monerium_order_id: null, settlement_ref: 'swan_a' });
    expect(logicalIntentState(intent)).toBe('underpaid');
    expect(logicalIntentState({ ...intent, state: 'expired', paid_at: null })).toBe('underpaid_expired');
  });

  it('matcher: druga uplata na isti sid je sid_already_settled', async () => {
    const { matchCreditEvent } = await import('../src/inflow/matcher');
    const { intent } = await underpaidFiat();
    const r = await matchCreditEvent(
      { defaultTenantId: 'italk', nowUnix: () => 0, getIntent: async () => intent, findByShortRef: async () => null, findStrayCandidates: async () => [] },
      { provider: 'swan', providerRef: 'x:booked', tenantId: 'sbx-t', receivingAccountId: 1, receivingIban: null, amountCents: 400,
        currency: 'EUR', remittance: 'sid:swanprobe01', endToEndId: null, debtorName: null, debtorAccount: null, scheme: 'sepa',
        finality: 'booked', occurredAt: 0, raw: null },
    );
    expect(r).toMatchObject({ kind: 'none', note: 'sid_already_settled: swanprobe01 (pending)' });
  });

  it('sandbox simulacija na namirenom fiat intentu: already_settled', async () => {
    const { simulatePayment } = await import('../src/sandbox/simulate');
    const { env, intent } = await underpaidFiat();
    expect(await simulatePayment(env, intent, 'paid', null)).toEqual({ ok: false, error: 'already_settled' });
  });
});

describe('migracija 0037: stari sintetski redovi', () => {
  it('briše swan_ order i fiat_notify forward, intent zadržava namiru', () => {
    const { raw } = migratedD1();
    raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, provider, monerium_order_id, forward_id)
                 VALUES ('old', ?, 500, 'paid', 0, 1, 'swan', 'swan_x', 1), ('nos', ?, 500, 'paid', 0, 1, 'swan', 'swan_y', 2)`)
      .run(FIAT_TARGET_PLACEHOLDER, FIAT_TARGET_PLACEHOLDER);
    raw.prepare(`INSERT INTO intent_settlements (sid, provider, settlement_ref, created_at) VALUES ('old', 'swan', 'swan_x', 0)`).run();
    // 'nos' nema red u intent_settlements (ne bi se smjelo dogoditi): ostaje netaknut.
    raw.prepare(`DELETE FROM intent_settlements WHERE sid = 'nos'`).run();
    for (const id of ['swan_x', 'swan_y', 'ord-1']) {
      raw.prepare(`INSERT INTO monerium_orders (id, kind, state, amount, currency, raw_json, updated_at) VALUES (?, 'issue', 'processed', '5.00', 'eur', '{}', 0)`).run(id);
    }
    raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, status, error, attempts, created_at, updated_at)
                 VALUES ('swan_x', ?, '0', 500, 'old', 'confirmed', 'fiat_notify', 0, 0, 0),
                        ('swan_y', ?, '0', 500, 'nos', 'confirmed', 'fiat_notify', 0, 0, 0),
                        ('ord-1', '0x1', '1', 500, 'm', 'confirmed', NULL, 0, 0, 0)`).run(FIAT_TARGET_PLACEHOLDER, FIAT_TARGET_PLACEHOLDER);
    raw.exec(readFileSync(join(__dirname, '..', 'migrations', '0037_fiat_bez_sintetskog_ordera.sql'), 'utf8'));
    expect(raw.prepare(`SELECT sid, monerium_order_id, forward_id FROM payment_intents ORDER BY sid`).all()).toEqual([
      { sid: 'nos', monerium_order_id: 'swan_y', forward_id: 2 },
      { sid: 'old', monerium_order_id: null, forward_id: null },
    ]);
    expect(raw.prepare(`SELECT id FROM monerium_orders ORDER BY id`).all()).toEqual([{ id: 'ord-1' }, { id: 'swan_y' }]);
    expect(raw.prepare(`SELECT order_id FROM monerium_forwards ORDER BY order_id`).all()).toEqual([{ order_id: 'ord-1' }, { order_id: 'swan_y' }]);
    expect(raw.prepare(`SELECT settlement_ref FROM intent_settlements WHERE sid = 'old'`).get()).toEqual({ settlement_ref: 'swan_x' });
  });
});

// Iz fiatSettlementReaders.test.ts (S2), nepromijenjen.
it('Monerium intent ne ide kroz fiat čitač', async () => {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, monerium_order_id)
               VALUES ('monsid00001', '0x1', 500, 'paid', 0, 1, 'ord-1')`).run();
  raw.prepare(`INSERT INTO intent_settlements (sid, provider, settlement_ref, created_at) VALUES ('monsid00001', 'monerium', 'ord-1', 0)`).run();
  const env = { DB: db } as unknown as Env;
  expect(await fiatSettlementOrder(env, { sid: 'monsid00001', provider: null, target_address: '0x1' })).toBeNull();
  expect(await fiatSettlementOrder(env, { sid: 'monsid00001', provider: 'monerium', target_address: '0x1' })).toBeNull();
});
