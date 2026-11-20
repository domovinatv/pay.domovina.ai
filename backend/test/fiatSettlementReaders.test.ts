import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import worker from '../src/index';
import { createReceivingAccount } from '../src/inflow/receivingAccounts';
import { encryptSecret, importKeks } from '../src/tenants/secrets';
import { fiatSettlementOrder } from '../src/inflow/settleFiat';
import { FIAT_TARGET_PLACEHOLDER } from '../src/inflow/provider';
import { getPaymentBundle, listPayments } from '../src/admin/v2/data';
import { loadScope } from '../src/admin/v2/scope';
import { SWAN_GRAPHQL_URL, SWAN_OAUTH_URL, type SwanTransaction } from '../src/providers/swan/client';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// S2 lanca „zatvaranje Swan” (ADR 0032 §4): čitatelji fiat namire uzimaju
/// uplatu iz `intent_settlements` + `credit_events`. settleFiat i dalje piše
/// sintetski `swan_…` order i `fiat_notify` forward, pa izlaz mora biti isti
/// sa i bez njih — to je uvjet da ih S3 smije prestati pisati.

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ACCOUNT = 'b31aae63-2a8f-42ad-a537-542899518fb8';
const NOW = Date.parse('2026-11-20T12:00:00Z');
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const WEBHOOK = readFileSync(join(__dirname, 'fixtures/swan/webhook-transaction-booked.json'), 'utf8');

function tx(sid: string): SwanTransaction {
  const j = JSON.parse(readFileSync(join(__dirname, 'fixtures/swan/transaction-sepa-instant-in-viban.json'), 'utf8')) as {
    data: { transaction: SwanTransaction };
  };
  return { ...j.data.transaction, label: `sid:${sid}`, account: { id: ACCOUNT } };
}

const CASES = [
  { name: 'Swan, živi tenant', tenant: 'swant', sandbox: 0, sid: 'swanprobe01', mode: 'production' as const },
  { name: 'Swan, sandbox tenant', tenant: 'sbx-swan01', sandbox: 1, sid: 'sbxswanpr01', mode: 'sandbox' as const },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup(c: (typeof CASES)[number], cents = 1234) {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at, sandbox)
               VALUES (?, 'Swan tenant', 'active', '[]', 'MPT Probe d.o.o.', 'FR7699999001003850976461402', 0, 0, ?)`).run(c.tenant, c.sandbox);
  const t = Math.floor(NOW / 1000);
  raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id, created_with_key, provider)
               VALUES (?, ?, ?, 'EUR', 'pending', ?, ?, ?, 1, 'swan')`).run(c.sid, FIAT_TARGET_PLACEHOLDER, cents, t - 60, t + 900, c.tenant);
  const env = {
    DB: db, DEFAULT_TENANT_ID: 'italk', MULTI_TENANT_RAIL: '1', TENANT_SECRETS_KEK: KEK,
    INTENT_REQUIRE_TENANT_KEY: '0', ALLOWED_ORIGINS: '',
  } as unknown as Env;
  // Merchant endpoint, da outbox ima isporuke: živi tenant iz tenant_rail,
  // sandbox tenant iz sandbox_tenants (outbox.ts endpointFor).
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
    if (url === SWAN_GRAPHQL_URL.sandbox) return Response.json({ data: { transaction: tx(c.sid) } });
    return new Response('ok', { status: 200 }); // merchant webhooks, alerts
  }));
  const res = await worker.fetch(
    new Request(`https://api.mpt.hr/api/swan/webhook/t/${c.tenant}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: WEBHOOK,
    }),
    env,
    ctx,
  );
  expect(await res.json()).toMatchObject({ ok: true, matched: true, sid: c.sid });
  return { env, raw };
}

/// Sve površine koje S2 drži jednakima.
async function snapshot(env: Env, raw: ReturnType<typeof migratedD1>['raw'], c: (typeof CASES)[number]) {
  const r = await worker.fetch(new Request(`https://api.mpt.hr/api/intents/${c.sid}`), env, ctx);
  expect(r.status).toBe(200);
  const intentJson = (await r.json()) as Record<string, unknown>;
  const bundle = (await getPaymentBundle(env, c.sid))!;
  const scope = await loadScope(env, c.mode);
  const list = await listPayments(env, scope, {});
  const outbox = raw.prepare(`SELECT id, type, payload, tenant_id FROM webhook_outbox ORDER BY id`).all();
  // `forwards` je lažni fiat_notify forward (nema isplate na lancu): S3 ga
  // prestaje pisati i to je jedina namjerna razlika, vidi decisions.md 203.
  const { forwards: _f, ...rest } = bundle;
  return { intentJson, bundle: rest, list, outbox };
}

function deleteSynthetic(raw: ReturnType<typeof migratedD1>['raw']) {
  const o = raw.prepare(`DELETE FROM monerium_orders WHERE id LIKE 'swan\\_%' ESCAPE '\\'`).run();
  const f = raw.prepare(`DELETE FROM monerium_forwards WHERE error = 'fiat_notify'`).run();
  expect([o.changes, f.changes]).toEqual([1, 1]);
}

describe.each(CASES)('fiat namira bez sintetskog reda: $name', (c) => {
  it('status, outbox i admin v2 (detalj + lista) isti su sa i bez sintetskog ordera/forwarda', async () => {
    const { env, raw } = await setup(c);
    const before = await snapshot(env, raw, c);
    // Polazište: plaćeno, fiat vremenska crta, dvije isporuke.
    expect(before.intentJson).toMatchObject({ state: 'paid', status: { stage: 'settled', settlement: 'fiat', provider: 'swan' } });
    expect(before.outbox.map((o) => (o as { type: string }).type).sort()).toEqual(['intent.paid', 'payment.received']);
    expect(before.bundle.order).toMatchObject({ id: 'swan_bosci_2c2198a642650d5571594e9da743a757', state: 'processed', counterpart_name: 'Ivan Horvat' });
    expect(before.list.items.map((i) => [i.sid, i.v2_status, i.settled_provider])).toEqual([[c.sid, 'paid', 'swan']]);

    deleteSynthetic(raw);
    const after = await snapshot(env, raw, c);
    expect(after).toEqual(before);
  });

  it('pogled iz credit eventa = sintetski red polje po polje (osim updated_at)', async () => {
    const { env, raw } = await setup(c);
    const stored = raw.prepare(`SELECT * FROM monerium_orders`).get() as Record<string, unknown>;
    const intent = raw.prepare(`SELECT sid, provider, target_address FROM payment_intents WHERE sid = ?`).get(c.sid) as {
      sid: string; provider: string; target_address: string;
    };
    const view = (await fiatSettlementOrder(env, intent)) as unknown as Record<string, unknown>;
    const { updated_at: _a, ...s } = stored;
    const { updated_at: _b, ...v } = view;
    expect(v).toEqual(s);
  });

  it('prije recordMatch (credit_event_id još NULL) booked događaj se nađe po ključu', async () => {
    const { env, raw } = await setup(c);
    const before = await snapshot(env, raw, c);
    raw.prepare(`UPDATE intent_settlements SET credit_event_id = NULL`).run();
    raw.prepare(`UPDATE credit_events SET settlement_ref = NULL`).run();
    deleteSynthetic(raw);
    const after = await snapshot(env, raw, c);
    // credit_event_id je dio prikaza namire u detalju; ostalo je isto.
    expect({ ...after, bundle: { ...after.bundle, settlement: null } }).toEqual({ ...before, bundle: { ...before.bundle, settlement: null } });
  });

  it('bez reda u intent_settlements čita se kao prije (sintetski order preko monerium_order_id)', async () => {
    const { env, raw } = await setup(c);
    const before = await snapshot(env, raw, c);
    raw.prepare(`DELETE FROM intent_settlements`).run();
    const after = await snapshot(env, raw, c);
    expect(after.intentJson).toEqual(before.intentJson);
  });
});

it('Monerium intent ne ide kroz fiat čitač', async () => {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, monerium_order_id)
               VALUES ('monsid00001', '0x1', 500, 'paid', 0, 1, 'ord-1')`).run();
  raw.prepare(`INSERT INTO intent_settlements (sid, provider, settlement_ref, created_at) VALUES ('monsid00001', 'monerium', 'ord-1', 0)`).run();
  const env = { DB: db } as unknown as Env;
  expect(await fiatSettlementOrder(env, { sid: 'monsid00001', provider: null, target_address: '0x1' })).toBeNull();
  expect(await fiatSettlementOrder(env, { sid: 'monsid00001', provider: 'monerium', target_address: '0x1' })).toBeNull();
});
