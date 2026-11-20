import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/// S4 lanca „zatvaranje Swan” (ADR 0032): golden REPLAY Monerium priljeva.
///
/// Prije nego `inflow/matcher.ts` preuzme odluku „koji intent ova Monerium
/// uplata plaća” (sid u memu / short_ref ADR 0028 / stray ADR 0018), ovaj test
/// snima VIDLJIVI ishod svakog postojećeg scenarija kroz pravi put:
/// `handleMoneriumWebhook(makeWebhookDeps(env, rail, ctx), …)` nad pravim
/// in-memory D1 (sve migracije), s valjanim potpisom webhooka. Lanac je
/// mockan samo na rubu (`router/safe`: forwardViaSafe bilježi poziv,
/// getForwardStatus = confirmed), fetch je stub (Telegram alerti i merchant
/// webhookovi se bilježe).
///
/// `fixtures/monerium/replay-pre-s4.json` je snimljen kodom s origin/main
/// prije S4 (5e52bbd) ovim istim testom uz CAPTURE_PRE_S4=1. Bez te varijable
/// test uspoređuje `compared` sekciju s `toEqual`. Sekcija `creditMatch`
/// (credit_events.matched_sid / matched_by / match_note) se snima, ali se NE
/// uspoređuje: S4 je namjerno mijenja.

const h = vi.hoisted(() => ({
  signed: [] as Array<{ safe: string; target: string; amountWei: string; sessionId: string | null; kind: string | null }>,
}));

vi.mock('../src/router/safe', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/router/safe')>();
  return {
    ...orig,
    forwardViaSafe: async (
      signer: { safe: string },
      args: { target: string; amountWei: bigint; sessionId?: string | null; kind?: string },
    ) => {
      h.signed.push({
        safe: signer.safe.toLowerCase(),
        target: args.target,
        amountWei: args.amountWei.toString(),
        sessionId: args.sessionId ?? null,
        kind: args.kind ?? null,
      });
      return { ok: true, txHash: `0x${String(h.signed.length).padStart(64, 'f')}` };
    },
    simulateForwardViaSafe: async () => ({ ok: false, error: 'replay: no simulation' }),
    getForwardStatus: async () => 'confirmed',
  };
});

import type { DatabaseSync } from 'node:sqlite';
import { handleMoneriumWebhook, makeWebhookDeps } from '../src/monerium/webhookHandler';
import { makeForwardDeps, rerouteParkedOrder } from '../src/monerium/forward';
import { makeOffRailDeps, markResolvedOffRail } from '../src/monerium/offrail';
import { getTenantRail, type TenantRail } from '../src/tenants/rail';
import type { MoneriumOrder } from '../src/monerium/types';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';
import { ITALK_SAFE, ITALK_WEBHOOK_SECRET, seedItalkRail } from './helpers/italkRail';

const GOLDEN = join(__dirname, 'fixtures/monerium/replay-pre-s4.json');
const CAPTURE = !!process.env.CAPTURE_PRE_S4;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const T = Math.floor(NOW / 1000);
const iso = (unix: number) => new Date(unix * 1000).toISOString();

const PAYEE_A = '0xa11ce00000000000000000000000000000000001';
const PAYEE_B = '0xb0b0000000000000000000000000000000000002';
const UNTRUSTED = '0xbad0000000000000000000000000000000000003';
const PROJECT = '0x9e0c000000000000000000000000000000000004';
const STRANGER = '0x5700000000000000000000000000000000000005';
const ROUTER_KEY = '0x' + '11'.repeat(32);
const HOOK = 'https://merchant.example/hook';
const OUT_SECRET = 'whsec_dGVzdA==';
const PAYER_IBAN = 'HR1210010051863000160';

// ---- harness ---------------------------------------------------------------

interface Harness {
  env: Env;
  raw: DatabaseSync;
  rail: TenantRail;
  pending: Promise<unknown>[];
  alerts: string[];
  merchantPosts: string[];
  responses: Array<{ status: number; body: Record<string, unknown> }>;
  nextId: number;
}

async function setup(opts: { mode?: 'forward' | 'direct'; stray?: boolean } = {}): Promise<Harness> {
  const { db, raw } = migratedD1();
  const mode = opts.mode ?? 'forward';
  const railEnv = await seedItalkRail(raw, {
    mode,
    routerKey: mode === 'forward' ? ROUTER_KEY : undefined,
    outbound: { url: HOOK, secret: OUT_SECRET },
  });
  for (const a of [PAYEE_A, PAYEE_B]) {
    raw.prepare(`INSERT INTO tenant_payout_addresses (tenant_id, address, label, source, created_at, created_by)
                 VALUES ('italk', ?, 'replay', 'admin', 0, 'test')`).run(a);
  }
  const env = {
    DB: db,
    ...railEnv,
    DEFAULT_TENANT_ID: 'italk',
    ALLOWED_ORIGINS: '',
    TELEGRAM_BOT_TOKEN: 'replay-bot',
    TELEGRAM_CHAT_ID: '-100',
    ...(opts.stray === false ? {} : { STRAY_RESOLVER: '1' }),
  } as unknown as Env;
  const rail = await getTenantRail(env, 'italk');
  if (!rail) throw new Error('rail not resolved');
  const hs: Harness = { env, raw, rail, pending: [], alerts: [], merchantPosts: [], responses: [], nextId: 1 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.telegram.org/')) {
      hs.alerts.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return Response.json({ ok: true });
    }
    if (url === HOOK) {
      const hdrs = new Headers(init?.headers);
      hs.merchantPosts.push(hdrs.get('webhook-id') ?? '?');
      return new Response('ok', { status: 200 });
    }
    throw new Error(`replay: unexpected fetch ${url}`);
  }));
  return hs;
}

type IntentOpts = { target?: string; cents?: number; state?: string; created?: number; expires?: number; withKey?: number };
function intent(hs: Harness, sid: string, o: IntentOpts = {}) {
  hs.raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id, created_with_key)
                  VALUES (?, ?, ?, 'EUR', ?, ?, ?, 'italk', ?)`)
    .run(sid, o.target ?? PAYEE_A, o.cents ?? 100, o.state ?? 'pending', o.created ?? T - 120, o.expires ?? T + 900, o.withKey ?? 1);
}

function shortRef(hs: Harness, code: string, sid: string) {
  hs.raw.prepare(`INSERT INTO intent_short_refs (tenant_id, short_ref, sid, hold_until) VALUES ('italk', ?, ?, ?)`)
    .run(code, sid, T + 3600);
}

function order(id: string, over: Partial<MoneriumOrder> = {}): MoneriumOrder {
  return {
    id,
    profile: 'prof-italk',
    kind: 'issue',
    state: 'processed',
    amount: '1.00',
    currency: 'eur',
    address: ITALK_SAFE,
    memo: '',
    counterpart: { identifier: { standard: 'iban', iban: PAYER_IBAN }, details: { name: 'Ana Platiša' } },
    meta: { placedAt: iso(T - 30), processedAt: iso(T - 20) },
    ...over,
  } as MoneriumOrder;
}

async function sign(secret: string, id: string, ts: string, body: string): Promise<string> {
  const raw = atob(secret.slice('whsec_'.length));
  const key = await crypto.subtle.importKey(
    'raw', Uint8Array.from(raw, (ch) => ch.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...sig))}`;
}

/// Wait for every waitUntil promise, advancing the fake clock so the receipt
/// poll's sleeps (CONFIRM_POLL_DELAYS_MS) elapse. Promises queued while
/// draining are drained too.
async function drain(pending: Promise<unknown>[]) {
  while (pending.length) {
    const batch = pending.splice(0);
    let done = false;
    const all = Promise.allSettled(batch).then((r) => { done = true; return r; });
    for (let i = 0; i < 500 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);
    if (!done) throw new Error('replay: waitUntil promises never settled');
    for (const r of await all) if (r.status === 'rejected') throw r.reason;
  }
}

async function deliver(hs: Harness, o: MoneriumOrder, opts: { type?: string; webhookId?: string } = {}) {
  const body = JSON.stringify({ type: opts.type ?? 'order.updated', data: o });
  const id = opts.webhookId ?? `msg_${hs.nextId++}`;
  const ts = '1700000000';
  const headers = new Headers({
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': await sign(ITALK_WEBHOOK_SECRET, id, ts, body),
    'content-type': 'application/json',
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => { hs.pending.push(p); } };
  const res = await handleMoneriumWebhook(makeWebhookDeps(hs.env, hs.rail, ctx), hs.rail, body, headers);
  hs.responses.push({ status: res.status, body: res.body });
  await drain(hs.pending);
  return res;
}

// ---- snapshot --------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/// Timestamps → markers (webhook payloads, audit details): keeps null vs set, drops the value.
function normalise(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => normalise(x));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalise(x, k)]));
  }
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'string' && ISO_RE.test(v)) return '<iso>';
  if (/(_at|At|timestamp)$/.test(key) && (typeof v === 'number' || typeof v === 'string')) return '<t>';
  return v;
}

function all(raw: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return raw.prepare(sql).all() as Array<Record<string, unknown>>;
}

function snapshot(hs: Harness) {
  const { raw } = hs;
  const creditRows = all(raw, `SELECT provider, provider_ref, tenant_id, receiving_account_id, receiving_iban, amount_cents,
                                      currency, remittance, end_to_end_id, debtor_name, debtor_account, scheme, finality,
                                      occurred_at, settlement_ref
                                 FROM credit_events ORDER BY provider, provider_ref`);
  const compared = {
    responses: hs.responses,
    payment_intents: all(raw, `SELECT sid, state, monerium_order_id, amount_received_cents, forward_tx_hash,
                                      forward_id IS NOT NULL AS forward_id_set, paid_at IS NOT NULL AS paid_set
                                 FROM payment_intents ORDER BY sid`),
    intent_settlements: all(raw, `SELECT sid, provider, settlement_ref, credit_event_id IS NOT NULL AS has_credit_event
                                    FROM intent_settlements ORDER BY sid`),
    monerium_forwards: all(raw, `SELECT order_id, sid, status, error, memo_prefix, target_address, amount_cents, amount_wei,
                                        tx_hash, attempts, tenant_id
                                   FROM monerium_forwards ORDER BY order_id, status, sid`),
    monerium_orders: all(raw, `SELECT id, state, tenant_id FROM monerium_orders ORDER BY id`),
    monerium_webhook_events: all(raw, `SELECT order_id, event_type, signature_ok, sid_extracted, sid_resolved, processing_note,
                                              amount_cents, tenant_id
                                         FROM monerium_webhook_events ORDER BY id`),
    credit_events: creditRows,
    webhook_outbox: all(raw, `SELECT id, type, tenant_id, status, attempts, payload FROM webhook_outbox ORDER BY id`)
      .map((r) => ({ ...r, payload: normalise(JSON.parse(String(r.payload))) })),
    merchant_posts: [...hs.merchantPosts].sort(),
    tenant_audit_log: all(raw, `SELECT tenant_id, action, address, actor, detail FROM tenant_audit_log ORDER BY id`)
      .map((r) => ({ ...r, detail: r.detail ? normalise(JSON.parse(String(r.detail))) : null })),
    forwardViaSafe: h.signed.map((s) => ({ ...s })),
    alerts: hs.alerts.map((a) => a.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<iso>')).sort(),
  };
  const creditMatch = all(raw, `SELECT provider_ref, matched_sid, matched_by, match_note FROM credit_events ORDER BY provider, provider_ref`);
  // DB columns above are chosen without wall-clock values (credit_events.occurred_at comes
  // from the order's meta); only webhook payloads and audit details are normalised.
  return { compared: compared as Record<string, unknown>, creditMatch };
}

// ---- golden ----------------------------------------------------------------

const captured: Record<string, ReturnType<typeof snapshot>> = {};
const golden: Record<string, ReturnType<typeof snapshot>> = CAPTURE || !existsSync(GOLDEN)
  ? {}
  : (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { scenarios: Record<string, ReturnType<typeof snapshot>> }).scenarios;

function check(name: string, hs: Harness) {
  const snap = snapshot(hs);
  if (CAPTURE) {
    captured[name] = snap;
    return;
  }
  expect(golden[name], `golden missing for ${name}`).toBeDefined();
  expect(snap.compared).toEqual(golden[name].compared);
}

afterAll(() => {
  if (!CAPTURE) return;
  const out = {
    note: 'Captured on origin/main 5e52bbd (pre-S4) by test/moneriumReplay.test.ts with CAPTURE_PRE_S4=1. '
      + '`compared` is asserted with toEqual; `creditMatch` is recorded only (S4 changes it on purpose).',
    scenarios: Object.fromEntries(Object.keys(captured).sort().map((k) => [k, captured[k]])),
  };
  writeFileSync(GOLDEN, JSON.stringify(out, null, 2) + '\n');
});

beforeEach(() => {
  h.signed.length = 0;
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- scenarios -------------------------------------------------------------

const sidMemo = (sid: string, target = PAYEE_A) => `mpt:${target}?sid=${sid}`;

describe('Monerium replay (golden pre-S4)', () => {
  it('01 sid in memo, exact amount → paid', async () => {
    const hs = await setup();
    intent(hs, 'sidexact01');
    await deliver(hs, order('ord-01', { memo: sidMemo('sidexact01') }));
    check('01_sid_exact_paid', hs);
  });

  it('02 sid, less than asked → underpaid', async () => {
    const hs = await setup();
    intent(hs, 'sidunder02', { cents: 200 });
    await deliver(hs, order('ord-02', { memo: sidMemo('sidunder02') }));
    check('02_sid_underpaid', hs);
  });

  it('03 sid, intent already expired → late', async () => {
    const hs = await setup();
    intent(hs, 'sidlate003', { state: 'expired', created: T - 2000, expires: T - 60 });
    await deliver(hs, order('ord-03', { memo: sidMemo('sidlate003') }));
    check('03_sid_expired_late', hs);
  });

  it('04a short_ref on a trusted intent → paid via code', async () => {
    const hs = await setup();
    intent(hs, 'coded00001');
    shortRef(hs, '0076', 'coded00001');
    // A second open trusted intent of the same amount: without the code the
    // stray resolver would see two candidates; the code must decide.
    intent(hs, 'stray00001', { created: T - 60 });
    await deliver(hs, order('ord-04a', { memo: '0076' }));
    check('04a_short_ref_trusted', hs);
  });

  it('04b short_ref on an untrusted intent → falls to stray, parked (untrusted)', async () => {
    const hs = await setup();
    intent(hs, 'coded00002', { target: UNTRUSTED, withKey: 0 });
    shortRef(hs, '0076', 'coded00002');
    await deliver(hs, order('ord-04b', { memo: '0076' }));
    check('04b_short_ref_untrusted_parked', hs);
  });

  it('04c short_ref on an untrusted intent + one trusted stray candidate → stray pays the trusted one', async () => {
    const hs = await setup();
    intent(hs, 'coded00003', { target: UNTRUSTED, withKey: 0 });
    shortRef(hs, '0076', 'coded00003');
    intent(hs, 'trusted003', { created: T - 200 });
    await deliver(hs, order('ord-04c', { memo: '0076' }));
    check('04c_short_ref_untrusted_falls_to_stray', hs);
  });

  it('05 stray: empty memo, one open trusted intent → paid (auto)', async () => {
    const hs = await setup();
    intent(hs, 'stray00005');
    await deliver(hs, order('ord-05'));
    check('05_stray_single_auto', hs);
  });

  it('06 stray ambiguous: two candidates, same target → newest, then the next order takes the other', async () => {
    const hs = await setup();
    intent(hs, 'strayold06', { created: T - 300 });
    intent(hs, 'straynew06', { created: T - 120 });
    await deliver(hs, order('ord-06a'));
    await deliver(hs, order('ord-06b'));
    check('06_stray_ambiguous_same_target', hs);
  });

  it('07 stray conflict: candidates to different targets → parked, nothing signed', async () => {
    const hs = await setup();
    intent(hs, 'conflictA7', { target: PAYEE_A, created: T - 300 });
    intent(hs, 'conflictB7', { target: PAYEE_B, created: T - 120 });
    await deliver(hs, order('ord-07'));
    check('07_stray_conflict_parked', hs);
  });

  it('08a stray none (no candidate) → parked no_routing_target', async () => {
    const hs = await setup();
    intent(hs, 'otheramt08', { cents: 999 });
    await deliver(hs, order('ord-08a'));
    check('08a_stray_none_parked', hs);
  });

  it('08b STRAY_RESOLVER unset, matching intent present → parked, resolver not consulted', async () => {
    const hs = await setup({ stray: false });
    intent(hs, 'matching08');
    await deliver(hs, order('ord-08b'));
    check('08b_stray_resolver_off_parked', hs);
  });

  it('09 double webhook: same webhook-id (dedup) and a new webhook-id → one forward, one settlement', async () => {
    const hs = await setup();
    intent(hs, 'sidtwice09');
    const o = order('ord-09', { memo: sidMemo('sidtwice09') });
    await deliver(hs, o, { webhookId: 'msg_dup' });
    await deliver(hs, o, { webhookId: 'msg_dup' });
    await deliver(hs, o, { webhookId: 'msg_other' });
    check('09_double_webhook', hs);
  });

  it('09b double webhook on a stray order → still one forward, one settlement', async () => {
    const hs = await setup();
    intent(hs, 'straytw09a', { created: T - 300 });
    intent(hs, 'straytw09b', { created: T - 120 });
    const o = order('ord-09b');
    await deliver(hs, o, { webhookId: 'msg_dup' });
    await deliver(hs, o, { webhookId: 'msg_dup' });
    await deliver(hs, o, { webhookId: 'msg_other' });
    check('09b_double_webhook_stray', hs);
  });

  it('10 order.created (pending) then order.updated processed: preview at created, forward only on processed', async () => {
    const hs = await setup();
    intent(hs, 'stray00010');
    intent(hs, 'sidcreat10', { cents: 250 });
    const stray = order('ord-10s');
    await deliver(hs, { ...stray, state: 'pending', meta: { placedAt: iso(T - 30) } } as MoneriumOrder, { type: 'order.created' });
    const forwardsAfterCreated = h.signed.length;
    await deliver(hs, stray);
    const withSid = order('ord-10m', { memo: sidMemo('sidcreat10'), amount: '2.50' });
    await deliver(hs, { ...withSid, state: 'pending', meta: { placedAt: iso(T - 30) } } as MoneriumOrder, { type: 'order.created' });
    expect(forwardsAfterCreated).toBe(0);
    await deliver(hs, withSid);
    check('10_created_then_processed', hs);
  });

  it('10b order.created after order.updated processed (out of order) → stale, no side effects', async () => {
    const hs = await setup();
    intent(hs, 'sidstale10');
    const o = order('ord-10b', { memo: sidMemo('sidstale10') });
    await deliver(hs, o);
    await deliver(hs, { ...o, state: 'pending' } as MoneriumOrder, { type: 'order.created' });
    check('10b_stale_created_after_processed', hs);
  });

  it('11 mint_address_mismatch: order minted outside the rail Safe → parked', async () => {
    const hs = await setup();
    intent(hs, 'sidmint011');
    await deliver(hs, order('ord-11', { memo: sidMemo('sidmint011'), address: STRANGER }));
    intent(hs, 'straymnt11', { cents: 300 });
    await deliver(hs, order('ord-11s', { amount: '3.00', address: STRANGER }));
    check('11_mint_address_mismatch', hs);
  });

  it('12 resolved_offrail: parked order settled by hand → redelivery does nothing', async () => {
    const hs = await setup();
    intent(hs, 'sidoffr012');
    const o = order('ord-12', { memo: sidMemo('sidoffr012'), address: STRANGER });
    await deliver(hs, o);
    const tx = '0x' + 'ab'.repeat(32);
    const offDeps = {
      ...makeOffRailDeps(hs.env, hs.rail),
      safeOutflows: async () => [{ logIndex: 3, to: PAYEE_A, valueWei: 10n ** 18n }],
    };
    const r = await markResolvedOffRail(offDeps, o, tx, 'ops@test');
    expect(r.ok).toBe(true);
    await drain(hs.pending);
    await deliver(hs, { ...o, address: ITALK_SAFE } as MoneriumOrder);
    // Operator reroute of the same order is refused too.
    expect(await rerouteParkedOrder(makeForwardDeps(hs.env, hs.rail), o, 'sidoffr012')).toBe('resolved_offrail');
    check('12_resolved_offrail_redelivery', hs);
  });

  it('13 bare 0x / gnosis: memo → parked, resolver not consulted', async () => {
    const hs = await setup();
    intent(hs, 'strayber13', { created: T - 200 });
    await deliver(hs, order('ord-13a', { memo: PAYEE_A }));
    await deliver(hs, order('ord-13b', { memo: `gnosis:${PAYEE_A}` }));
    await deliver(hs, order('ord-13c', { memo: `gnosis:${PAYEE_A}?sid=strayber13` }));
    check('13_bare_0x_and_gnosis_parked', hs);
  });

  it('14a direct mode: stray minted into the main Safe → D4 owed', async () => {
    const hs = await setup({ mode: 'direct' });
    intent(hs, 'directow14', { target: PROJECT });
    await deliver(hs, order('ord-14a'));
    check('14a_direct_stray_owed', hs);
  });

  it('14b direct mode: memo names project + sid, minted there → direct_settle paid', async () => {
    const hs = await setup({ mode: 'direct' });
    intent(hs, 'directst14', { target: PROJECT });
    await deliver(hs, order('ord-14b', { memo: `gnosis:${PROJECT} sid:directst14`, address: PROJECT }));
    check('14b_direct_settle_memo', hs);
  });

  it('14c direct mode: memo sid, minted into the main Safe → D4 owed (no resolver)', async () => {
    const hs = await setup({ mode: 'direct' });
    intent(hs, 'directmm14', { target: PROJECT });
    await deliver(hs, order('ord-14c', { memo: `sid:directmm14` }));
    check('14c_direct_sid_owed', hs);
  });

  it('15 operator reroute of a parked conflict onto a chosen sid', async () => {
    const hs = await setup();
    intent(hs, 'rerouteA15', { target: PAYEE_A, created: T - 300 });
    intent(hs, 'rerouteB15', { target: PAYEE_B, created: T - 120 });
    const o = order('ord-15');
    await deliver(hs, o);
    const p = rerouteParkedOrder(makeForwardDeps(hs.env, hs.rail), o, 'rerouteA15');
    hs.pending.push(p);
    await drain(hs.pending);
    hs.responses.push({ status: 0, body: { reroute: await p } });
    // A second reroute of the same order is refused.
    hs.responses.push({ status: 0, body: { reroute: await rerouteParkedOrder(makeForwardDeps(hs.env, hs.rail), o, 'rerouteB15') } });
    check('15_operator_reroute', hs);
  });
});
