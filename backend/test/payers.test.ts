import { describe, expect, it } from 'vitest';

import worker from '../src/index';
import { ibanLast4, initials, payerRef } from '../src/payers/api';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// GET /api/payers/:address (migration 0032): initials + last 4 IBAN chars per
/// payment to one address, only for tenants that opted in. Never the name, the
/// IBAN or the sid.

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const SAFE = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

function setup() {
  const { db, raw } = migratedD1();
  raw.prepare(`INSERT OR IGNORE INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
               VALUES ('italk', 'ITalk', 'active', '[]', 'ITalk d.o.o.', 'EE707777000162921128', 0, 0)`).run();
  raw.prepare(`UPDATE tenants SET public_payer_tags = 1 WHERE id = 'italk'`).run();
  raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
               VALUES ('other', 'Other', 'active', '[]', 'Other', 'EE707777000162921128', 0, 0)`).run();
  const env = { DB: db, DEFAULT_TENANT_ID: 'italk', ALLOWED_ORIGINS: '' } as unknown as Env;
  const order = (id: string, over: Record<string, unknown> = {}) => {
    const row = {
      id, kind: 'issue', state: 'processed', amount: '25.00', currency: 'eur', address: null, chain: 'gnosis',
      counterpart_iban: 'HR12 1001 0051 8630 0016 0', counterpart_name: 'Matija Stepanić', tx_hashes: null,
      placed_at: '2026-10-21T10:00:00Z', raw_json: '{}', updated_at: 0, tenant_id: 'italk', ...over,
    };
    const cols = Object.keys(row);
    raw.prepare(`INSERT INTO monerium_orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...(Object.values(row) as never[]));
  };
  const intent = (sid: string, orderId: string, target: string, forwardTx: string | null = null) => {
    raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at,
                   tenant_id, monerium_order_id, forward_tx_hash, paid_at)
                 VALUES (?, ?, 2500, 'eur', 'paid', 0, 900, 'italk', ?, ?, 1)`).run(sid, target, orderId, forwardTx);
  };
  return { env, raw, order, intent };
}

async function list(env: Env, address: string) {
  const res = await worker.fetch(new Request(`https://mpt.domovina.ai/api/payers/${address}`), env, ctx);
  return { status: res.status, body: (await res.json()) as { data?: Array<Record<string, unknown>>; error?: string } };
}

describe('initials / ibanLast4', () => {
  it.each([
    ['Matija Stepanić', 'M. S.'],
    ['STEPANIC MATIJA', 'S. M.'],
    ['Ana Marija Horvat Kovač', 'A. K.'],
    ['ITALK D.O.O.', 'I.'],
    ['đuro', 'Đ.'],
    ['', null],
    [null, null],
  ])('%s → %s', (name, want) => expect(initials(name)).toBe(want));

  it('takes the last 4 of the normalised IBAN, never a short fragment', () => {
    expect(ibanLast4('HR12 1001 0051 8630 0016 0')).toBe('0160');
    expect(ibanLast4('HR12')).toBeNull();
    expect(ibanLast4(null)).toBeNull();
  });
});

describe('GET /api/payers/:address', () => {
  it('tags a payment through its intent, with mint and forward hashes, and leaks nothing else', async () => {
    const { env, order, intent } = setup();
    order('o1', { tx_hashes: JSON.stringify(['0xAAA']) });
    intent('sid-secret-1', 'o1', SAFE, '0xBBB');
    const { status, body } = await list(env, SAFE);
    expect(status).toBe(200);
    expect(body.data).toEqual([{
      initials: 'M. S.', iban_last4: '0160', amount_cents: 2500, received_at: '2026-10-21T10:00:00Z',
      state: 'minted', tx_hashes: ['0xaaa', '0xbbb'], ref: await payerRef('sid-secret-1'),
    }]);
    expect(await payerRef('sid-secret-1')).toMatch(/^[0-9a-f]{16}$/);
    const text = JSON.stringify(body);
    for (const leak of ['Stepani', 'HR12', '1001', 'sid-secret-1']) expect(text).not.toContain(leak);
  });

  it('lists a received payment before it is minted, newest first', async () => {
    const { env, order, intent } = setup();
    order('old', { placed_at: '2026-10-20T10:00:00Z' });
    intent('s-old', 'old', SAFE);
    order('new', { state: 'pending', placed_at: '2026-10-21T12:00:00Z', counterpart_name: 'Ivo Ivić' });
    intent('s-new', 'new', SAFE);
    const { body } = await list(env, SAFE);
    expect(body.data?.map((d) => [d.initials, d.state])).toEqual([['I. I.', 'received'], ['M. S.', 'minted']]);
  });

  it('finds direct mints and rail forwards, matching the address case-insensitively', async () => {
    const { env, raw, order } = setup();
    order('direct', { address: '0x' + SAFE.slice(2).toUpperCase(), placed_at: '2026-10-21T11:00:00Z' });
    order('fwd', { placed_at: '2026-10-21T10:00:00Z' });
    raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, status, tx_hash, created_at, updated_at)
                 VALUES ('fwd', ?, '0', 'confirmed', '0xCCC', 0, 0)`).run(SAFE);
    const { body } = await list(env, '0x' + SAFE.slice(2).toUpperCase());
    expect(body.data?.map((d) => [d.tx_hashes, d.ref])).toEqual([[[], null], [['0xccc'], null]]);
  });

  it('skips rejected orders, other addresses and tenants that did not opt in', async () => {
    const { env, order, intent } = setup();
    order('rej', { state: 'rejected' });
    intent('s-rej', 'rej', SAFE);
    order('elsewhere');
    intent('s-else', 'elsewhere', OTHER);
    order('foreign', { tenant_id: 'other' });
    intent('s-foreign', 'foreign', SAFE);
    expect((await list(env, SAFE)).body.data).toEqual([]);
  });

  it('rejects a malformed address', async () => {
    const { env } = setup();
    expect((await list(env, '0x123')).status).toBe(400);
  });
});
