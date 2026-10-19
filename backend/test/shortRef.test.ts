import { describe, expect, it } from 'vitest';

import {
  allocateShortRef,
  dammCheckDigit,
  findIntentByShortRef,
  isValidShortRef,
  parseShortRef,
  shortRefFromBody,
  shortRefFromOrder,
} from '../src/intents/shortRef';
import { eurToWei, handleForward, previewStraySid, type ForwardDeps } from '../src/monerium/forward';
import type { StrayCandidate } from '../src/monerium/strayResolver';
import type { MoneriumOrder } from '../src/monerium/types';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';
import { seedItalkRail } from './helpers/italkRail';

/// ADR 0028: short intent reference (body + Damm check digit).

const PAYEE = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';
const SAFE = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';
const NOW = 1_800_000_000;

describe('Damm check digit', () => {
  it('matches the reference vector (572 → 4)', () => {
    expect(dammCheckDigit('572')).toBe('4');
    expect(isValidShortRef('5724')).toBe(true);
  });

  it('every single wrong digit is caught, for every 3-digit body', () => {
    for (let n = 0; n < 1000; n++) {
      const code = shortRefFromBody(String(n).padStart(3, '0'));
      expect(isValidShortRef(code)).toBe(true);
      for (let pos = 0; pos < code.length; pos++) {
        for (let d = 0; d < 10; d++) {
          if (String(d) === code[pos]) continue;
          const typo = code.slice(0, pos) + d + code.slice(pos + 1);
          expect(isValidShortRef(typo), `${code} → ${typo}`).toBe(false);
        }
      }
    }
  });

  it('every swap of adjacent different digits is caught (09↔90 included)', () => {
    for (let n = 0; n < 1000; n++) {
      const code = shortRefFromBody(String(n).padStart(3, '0'));
      for (let pos = 0; pos < code.length - 1; pos++) {
        if (code[pos] === code[pos + 1]) continue;
        const swapped = code.slice(0, pos) + code[pos + 1] + code[pos] + code.slice(pos + 2);
        expect(isValidShortRef(swapped), `${code} → ${swapped}`).toBe(false);
      }
    }
  });
});

describe('parseShortRef', () => {
  const code = shortRefFromBody('007'); // 0076

  it('accepts the code alone, spaced, dashed or next to words', () => {
    expect(code).toBe('0076');
    for (const text of ['0076', ' 0076 ', '007-6', '0 0 7 6', 'Lukavec 0076', 'ref: 0076.']) {
      expect(parseShortRef(text), text).toBe('0076');
    }
  });

  it('rejects a wrong check digit, two numbers, too short/long and empty', () => {
    for (const text of ['0071', '0076 12', '20.10. 0076', '076', '12345678', '', null, 'uplata']) {
      expect(parseShortRef(text), String(text)).toBeNull();
    }
  });

  it('memo and referenceNumber must not disagree', () => {
    expect(shortRefFromOrder({ memo: '0076', referenceNumber: null })).toBe('0076');
    expect(shortRefFromOrder({ memo: 'x', referenceNumber: '0076' })).toBe('0076');
    expect(shortRefFromOrder({ memo: '0076', referenceNumber: '0076' })).toBe('0076');
    expect(shortRefFromOrder({ memo: '0076', referenceNumber: shortRefFromBody('123') })).toBeNull();
  });
});

function db() {
  const { db, raw } = migratedD1();
  const env = { DB: db } as unknown as Env;
  const intent = (sid: string, opts: { tenant?: string; state?: string; withKey?: number; target?: string } = {}) =>
    raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id, created_with_key)
                 VALUES (?, ?, 100, 'eur', ?, ?, ?, ?, ?)`)
      .run(sid, opts.target ?? PAYEE, opts.state ?? 'pending', NOW, NOW + 900, opts.tenant ?? 'italk', opts.withKey ?? 1);
  const hold = (tenant: string, code: string, sid: string, holdUntil: number) =>
    raw.prepare(`INSERT INTO intent_short_refs (tenant_id, short_ref, sid, hold_until) VALUES (?, ?, ?, ?)`)
      .run(tenant, code, sid, holdUntil);
  const alloc = (sid: string, tenantId = 'italk', nowUnix = NOW) =>
    allocateShortRef(env, { tenantId, sid, holdUntil: nowUnix + 900 + 48 * 3600, nowUnix });
  return { env, raw, intent, hold, alloc };
}

describe('allocation (SQLite, every migration)', () => {
  it('gives a valid 3+1 code and records it on the intent', async () => {
    const { raw, intent, alloc } = db();
    intent('s1');
    const code = await alloc('s1');
    expect(code).toMatch(/^\d{4}$/);
    expect(isValidShortRef(code!)).toBe(true);
    expect((raw.prepare(`SELECT short_ref FROM payment_intents WHERE sid = 's1'`).get() as { short_ref: string }).short_ref)
      .toBe(code);
  });

  it('200 allocations at once never share a code', async () => {
    const { intent, alloc } = db();
    for (let i = 0; i < 200; i++) intent(`s${i}`);
    const codes = await Promise.all(Array.from({ length: 200 }, (_, i) => alloc(`s${i}`)));
    expect(new Set(codes).size).toBe(200);
  });

  it('D1 holds uniqueness: the upsert never takes a live code, even from a stale read', async () => {
    const { raw, intent, hold } = db();
    intent('owner');
    intent('late');
    hold('italk', '0076', 'owner', NOW + 100);
    const upsert = raw.prepare(
      `INSERT INTO intent_short_refs AS r (tenant_id, short_ref, sid, hold_until) VALUES ('italk', '0076', 'late', ?)
       ON CONFLICT (tenant_id, short_ref) DO UPDATE SET sid = excluded.sid, hold_until = excluded.hold_until
        WHERE NOT (r.hold_until > ? AND NOT EXISTS (SELECT 1 FROM payment_intents p WHERE p.sid = r.sid AND p.state = 'paid'))`,
    );
    expect(Number(upsert.run(NOW + 999, NOW).changes)).toBe(0);
    expect(Number(upsert.run(NOW + 999, NOW + 100).changes)).toBe(1); // hold over → taken
  });

  it('full 3+1 pool → the body grows to 4+1', async () => {
    const { raw, intent, alloc } = db();
    intent('holder');
    const ins = raw.prepare(`INSERT INTO intent_short_refs (tenant_id, short_ref, sid, hold_until) VALUES ('italk', ?, 'holder', ?)`);
    raw.exec('BEGIN');
    for (let n = 0; n < 1000; n++) ins.run(shortRefFromBody(String(n).padStart(3, '0')), NOW + 100);
    raw.exec('COMMIT');
    intent('next');
    const code = await alloc('next');
    expect(code).toMatch(/^\d{5}$/);
    expect(isValidShortRef(code!)).toBe(true);
  });

  it('rotation: one free 3+1 code left → that one; a held-over or paid code is reused', async () => {
    const { raw, intent, alloc } = db();
    intent('holder');
    intent('paid-one', { state: 'paid' });
    const ins = raw.prepare(`INSERT INTO intent_short_refs (tenant_id, short_ref, sid, hold_until) VALUES ('italk', ?, ?, ?)`);
    raw.exec('BEGIN');
    for (let n = 0; n < 1000; n++) {
      const c = shortRefFromBody(String(n).padStart(3, '0'));
      if (n === 7) ins.run(c, 'holder', NOW); // hold ends now → dead
      else if (n === 8) ins.run(c, 'paid-one', NOW + 100); // paid → freed early
      else ins.run(c, 'holder', NOW + 100);
    }
    raw.exec('COMMIT');
    intent('a');
    intent('b');
    intent('c');
    const got = [await alloc('a'), await alloc('b')].sort();
    expect(got).toEqual([shortRefFromBody('007'), shortRefFromBody('008')]);
    expect(await alloc('c')).toMatch(/^\d{5}$/);
  });

  it('codes are per tenant: the same code may live in two tenants', async () => {
    const { intent, hold, env } = db();
    intent('x1', { tenant: 'italk' });
    intent('x2', { tenant: 'other' });
    hold('italk', '0076', 'x1', NOW + 100);
    hold('other', '0076', 'x2', NOW + 100);
    const find = (tenantId: string) =>
      findIntentByShortRef(env, { tenantId, code: '0076', nowUnix: NOW, defaultTenantId: 'italk' });
    expect((await find('italk'))?.sid).toBe('x1');
    expect((await find('other'))?.sid).toBe('x2');
    expect(await find('third')).toBeNull();
  });
});

describe('findIntentByShortRef', () => {
  const find = (env: Env, code = '0076', nowUnix = NOW) =>
    findIntentByShortRef(env, { tenantId: 'italk', code, nowUnix, defaultTenantId: 'italk' });

  it('live pending and expired-within-hold intents match; trust flag as in SR-01', async () => {
    const { env, intent, hold } = db();
    intent('s1', { withKey: 0, target: '0x' + 'ab'.repeat(20) });
    hold('italk', '0076', 's1', NOW + 100);
    expect(await find(env)).toEqual({ sid: 's1', target_address: '0x' + 'ab'.repeat(20), trusted: false });
  });

  it('hold over, paid, or already taken by a live forward → null', async () => {
    const { env, raw, intent, hold } = db();
    intent('s1');
    hold('italk', '0076', 's1', NOW + 100);
    expect(await find(env, '0076', NOW + 100)).toBeNull();
    raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, sid, status, created_at, updated_at)
                 VALUES ('o1', ?, '1', 's1', 'pending', 0, 0)`).run(PAYEE);
    expect(await find(env)).toBeNull();
    raw.prepare(`DELETE FROM monerium_forwards`).run();
    raw.prepare(`UPDATE payment_intents SET state = 'paid' WHERE sid = 's1'`).run();
    expect(await find(env)).toBeNull();
  });
});

// ---- handleForward: the code decides before the stray resolver ----

interface Rec {
  inserts: Array<Parameters<ForwardDeps['insertForward']>[0]>;
  forwards: Array<{ target: string; amountWei: bigint }>;
  alerts: string[];
  strayAsked: number;
  codes: string[];
}

function harness(
  byCode: Record<string, { sid: string; target_address: string; trusted: boolean }>,
  strays: StrayCandidate[] = [],
): { deps: ForwardDeps; rec: Rec } {
  const rec: Rec = { inserts: [], forwards: [], alerts: [], strayAsked: 0, codes: [] };
  const targets = new Map<string, string>([
    ...Object.values(byCode).map((h) => [h.sid, h.target_address] as [string, string]),
    ...strays.map((c) => [c.sid, c.target_address] as [string, string]),
  ]);
  const deps: ForwardDeps = {
    authorize: {
      getIntentBySid: async (sid) => targets.has(sid)
        ? { target_address: targets.get(sid)!, tenant_id: 'italk', state: 'pending', amount_cents: 100, monerium_order_id: null }
        : null,
      getCampaignById: async () => null,
      getTenantStatus: async () => 'active',
      isWhitelisted: async (_t, addr) => addr.toLowerCase() === PAYEE,
      safeAddress: SAFE,
      defaultTenantId: 'italk',
      railTenantId: 'italk',
      requireMintAt: null,
      maxForwardCents: null,
    },
    getForwardByOrder: async () => null,
    insertForward: async (args) => {
      rec.inserts.push(args);
      return rec.inserts.length;
    },
    updateForward: async () => {},
    forward: async (args) => {
      rec.forwards.push({ target: args.target, amountWei: args.amountWei });
      return { ok: true, txHash: '0xbeef' as `0x${string}` };
    },
    settleNonRoutedPaid: async () => true,
    pollConfirmation: async () => 'confirmed',
    alert: async (text) => { rec.alerts.push(text); },
    audit: async () => {},
    emitBlocked: async () => {},
    findByShortRef: async (code) => {
      rec.codes.push(code);
      return byCode[code] ?? null;
    },
    findStrayCandidates: async () => {
      rec.strayAsked++;
      return strays;
    },
    nowUnix: () => NOW,
  };
  return { deps, rec };
}

function order(memo: string, amount = '1.00'): MoneriumOrder {
  return {
    id: 'ord-code',
    kind: 'issue',
    state: 'processed',
    amount,
    currency: 'eur',
    memo,
    meta: { placedAt: new Date(NOW * 1000).toISOString() },
  } as unknown as MoneriumOrder;
}

const STRAY: StrayCandidate = {
  sid: 'stray-sid', target_address: PAYEE, state: 'pending',
  created_at: NOW - 60, expires_at: NOW + 600, trusted: true,
};

describe('handleForward — short code (ADR 0028)', () => {
  it('a valid code of a live intent → forwarded to that intent, tagged code, resolver not asked', async () => {
    const { deps, rec } = harness({ '0076': { sid: 'coded', target_address: PAYEE, trusted: true } }, [STRAY]);
    await handleForward(deps, order('0076'));
    expect(rec.codes).toEqual(['0076']);
    expect(rec.strayAsked).toBe(0);
    expect(rec.inserts[0]).toMatchObject({ sid: 'coded', memoPrefix: 'code', targetAddress: PAYEE, status: 'pending' });
    expect(rec.forwards).toEqual([{ target: PAYEE, amountWei: eurToWei('1.00') }]);
    expect(rec.alerts[0]).toContain('kratkoj referenci');
  });

  it('a wrong check digit is never looked up → ordinary stray path', async () => {
    const { deps, rec } = harness({ '0071': { sid: 'coded', target_address: PAYEE, trusted: true } }, [STRAY]);
    await handleForward(deps, order('0071'));
    expect(rec.codes).toEqual([]);
    expect(rec.strayAsked).toBe(1);
    expect(rec.inserts[0]).toMatchObject({ sid: 'stray-sid', memoPrefix: 'auto' });
  });

  it("an unknown code (or another tenant's — the lookup is per rail tenant) → stray path", async () => {
    const { deps, rec } = harness({}, [STRAY]);
    await handleForward(deps, order('0076'));
    expect(rec.codes).toEqual(['0076']);
    expect(rec.inserts[0]).toMatchObject({ sid: 'stray-sid', memoPrefix: 'auto' });
  });

  it('an untrusted intent never catches a code (SR-01) → stray path', async () => {
    const { deps, rec } = harness({ '0076': { sid: 'coded', target_address: PAYEE, trusted: false } }, []);
    await handleForward(deps, order('0076'));
    expect(rec.strayAsked).toBe(1);
    expect(rec.forwards).toHaveLength(0);
  });

  it('a memo with a sid or an address is not a stray: the code is not consulted', async () => {
    const { deps, rec } = harness({ '0076': { sid: 'coded', target_address: PAYEE, trusted: true } });
    await handleForward(deps, order(`mpt:${PAYEE}?sid=abcdefgh 0076`));
    expect(rec.codes).toEqual([]);
  });

  it('the gate still decides: a coded intent off the whitelist parks', async () => {
    const other = '0x' + 'cd'.repeat(20);
    const { deps, rec } = harness({ '0076': { sid: 'coded', target_address: other, trusted: true } });
    await handleForward(deps, order('0076'));
    expect(rec.forwards).toHaveLength(0);
  });

  it('preview lights the coded intent at order.created', async () => {
    const { deps } = harness({ '0076': { sid: 'coded', target_address: PAYEE, trusted: true } }, [STRAY]);
    expect(await previewStraySid(deps, { ...order('0076'), state: 'placed' } as MoneriumOrder)).toBe('coded');
  });
});

describe('POST /api/intents — short_ref in the response', async () => {
  const { default: worker } = await import('../src/index');
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it('POST and GET carry the same valid short_ref', async () => {
    const { db: d1, raw } = migratedD1();
    const rail = await seedItalkRail(raw, { mode: 'forward' });
    raw.prepare(`INSERT INTO tenant_payout_addresses (tenant_id, address, label, source, created_at, created_by)
                 VALUES ('italk', ?, 'campaign Lukavec', 'admin', 0, 'test')`).run(PAYEE);
    const env = {
      DB: d1, ...rail, ALLOWED_ORIGINS: 'https://mpt.domovina.ai', DEFAULT_TENANT_ID: 'italk',
      INTENT_REQUIRE_TENANT_KEY: '0', MONERIUM_IBAN: 'EE000000000000000000', MONERIUM_BENEFICIARY_NAME: 'ITalk',
    } as unknown as Env;
    const res = await worker.fetch(new Request('https://mpt.domovina.ai/api/intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_address: PAYEE, amount_eur: '1.00' }),
    }), env, ctx);
    expect(res.status).toBe(200);
    const created = await res.json() as { sid: string; short_ref: string };
    expect(isValidShortRef(created.short_ref)).toBe(true);
    const got = await (await worker.fetch(new Request(`https://mpt.domovina.ai/api/intents/${created.sid}`), env, ctx))
      .json() as { short_ref: string };
    expect(got.short_ref).toBe(created.short_ref);
    const page = await (await worker.fetch(new Request(`https://mpt.domovina.ai/checkout/${created.sid}`), env, ctx)).text();
    expect(page).toContain(`data-revolut-reference>${created.short_ref}<`);
  });
});
