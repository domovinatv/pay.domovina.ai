import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { buildIntentApi } from '../src/intents/api';
import { buildReceiptAnchorApi } from '../src/receipts/routes';
import { generateSid } from '../src/intents/sid';
import { handleForward, type ForwardDeps } from '../src/monerium/forward';
import type { MoneriumOrder } from '../src/monerium/types';
import { receiptRequestMessage } from '../src/receipts/api';
import {
  anchorPendingLeaves, buildOtsFile, chainHead, otsHasBitcoin, proofForLeaf, proofsForAnchor, pullUpgradedOts, sha256, ZERO32,
} from '../src/receipts/anchor';
import { linkReceipts, sameHolder } from '../src/receipts/link';
import { leafHash, merkleProof, merkleRoot, verifyMerkleProof } from '../src/receipts/merkle';
import {
  deriveReceiptSid,
  isReceiptSid,
  receiptKind,
  receiptSidMatches,
} from '../src/receipts/sid';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0022 — payment receipts bound to the payer's key.

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const OWNER = privateKeyToAccount(PK).address;
const SALT = '0x000102030405060708090a0b0c0d0e0f' as Hex;

describe('receipt sid (§1)', () => {
  it('is r1 + 24 chars of the confusable-free alphabet, deterministic', () => {
    const sid = deriveReceiptSid(OWNER, SALT);
    expect(sid).toMatch(/^r1[abcdefghijkmnpqrstuvwxyz23456789]{24}$/);
    expect(deriveReceiptSid(OWNER.toLowerCase(), SALT)).toBe(sid);
    expect(isReceiptSid(sid)).toBe(true);
    expect(sid.length).toBeLessThanOrEqual(32); // fits SID_RE and bytes32
  });

  it('golden vector: keccak over exactly domain ‖ owner (20 B) ‖ salt (16 B)', () => {
    // Same value from scripts/mpt_receipt_verify.py (pure-Python keccak) and
    // energy.domovina.ai docs/16 — the three implementations must agree.
    expect(deriveReceiptSid(OWNER, SALT)).toBe('r183ns4pcpn659hd2z3xtaqiwq');
    expect(OWNER).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });

  it('every hex letter of the owner matters', () => {
    const a = '0x' + 'a'.repeat(40);
    const b = '0x' + 'b'.repeat(40);
    expect(deriveReceiptSid(a, SALT)).not.toBe(deriveReceiptSid(b, SALT));
  });

  it('binds owner and salt: any change gives another sid', () => {
    const sid = deriveReceiptSid(OWNER, SALT);
    expect(receiptSidMatches(sid, OWNER, SALT)).toBe(true);
    expect(receiptSidMatches(sid, OWNER, ('0x' + '00'.repeat(15) + '01') as Hex)).toBe(false);
    expect(receiptSidMatches(sid, '0x' + '11'.repeat(20), SALT)).toBe(false);
    expect(receiptSidMatches(sid, 'nope', SALT)).toBe(false);
  });

  it('a legacy random sid is never a receipt sid (its alphabet has no "1")', () => {
    for (let i = 0; i < 200; i++) expect(isReceiptSid(generateSid())).toBe(false);
    expect(isReceiptSid('r1short')).toBe(false);
    expect(isReceiptSid(null)).toBe(false);
  });

  it('kind: rcpt1 only when the sid came in the remittance (§3)', () => {
    const sid = deriveReceiptSid(OWNER, SALT);
    expect(receiptKind(sid, null)).toBe('rcpt1');
    expect(receiptKind(sid, 'auto')).toBe('rcpt1-unbound');
    expect(receiptKind(sid, 'manual')).toBe('rcpt1-unbound');
    expect(receiptKind('z232pb646itg', null)).toBeUndefined();
    expect(receiptKind(null, null)).toBeUndefined();
  });
});

describe('merkle (§5)', () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) =>
    leafHash({ kind: 'lazy', sid: 'r1x', orderId: `o${i}`, txHash: null, amountCents: i + 1 }));

  it('every leaf proves against the root, for odd and even sizes', () => {
    for (let n = 1; n <= 9; n++) {
      const ls = leaves(n);
      const root = merkleRoot(ls);
      ls.forEach((l, i) => expect(verifyMerkleProof(l, merkleProof(ls, i), root)).toBe(true));
    }
  });

  it('a foreign leaf does not prove', () => {
    const ls = leaves(5);
    expect(verifyMerkleProof(leaves(6)[5], merkleProof(ls, 0), merkleRoot(ls))).toBe(false);
  });

  it('direct and lazy leaves are domain-separated', () => {
    const base = { sid: 'r1x', orderId: 'o1', txHash: null, amountCents: 100 };
    expect(leafHash({ kind: 'direct', ...base })).not.toBe(leafHash({ kind: 'lazy', ...base }));
  });
});

// ---- lazy issuance against real SQLite + every migration (§3a) ----

const IBAN = 'HR1210010051863000160';
const ANCHOR_SID = deriveReceiptSid(OWNER, SALT);

function setup() {
  const { db, raw } = migratedD1();
  const env = { DB: db } as unknown as Env;
  let fid = 0;
  const pay = (
    id: string,
    placedAt: string,
    o: {
      iban?: string | null;
      name?: string;
      state?: string;
      sid?: string | null;
      prefix?: string | null;
      status?: string;
      amount?: string;
    } = {},
  ) => {
    raw.prepare(
      `INSERT INTO monerium_orders (id, kind, state, amount, currency, counterpart_iban, counterpart_name,
         tx_hashes, placed_at, raw_json, updated_at, tenant_id)
       VALUES (?, 'issue', ?, ?, 'eur', ?, ?, ?, ?, '{}', 0, 'italk')`,
    ).run(id, o.state ?? 'processed', o.amount ?? '5.00', o.iban === undefined ? 'HR12 1001 0051 8630 0016 0' : o.iban,
      o.name ?? 'Ivan Horvat', JSON.stringify([`0x${(++fid).toString(16).padStart(64, '0')}`]), placedAt);
    raw.prepare(
      `INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, memo_prefix, status,
         tx_hash, attempts, created_at, updated_at, tenant_id)
       VALUES (?, '0xpayee', '0', 500, ?, ?, ?, ?, 1, 0, 0, 'italk')`,
    ).run(id, o.sid ?? null, o.prefix === undefined ? 'cmp' : o.prefix, o.status ?? 'confirmed',
      `0x${'f'.repeat(63)}${fid % 10}`);
  };
  const leaves = () => raw.prepare(`SELECT kind, sid, order_id, name_mismatch FROM receipt_leaves ORDER BY id`).all() as
    Array<{ kind: string; sid: string; order_id: string; name_mismatch: number }>;
  const alerts: string[] = [];
  const deps = { alert: async (t: string) => { alerts.push(t); }, nowUnix: () => 1_000 };
  return { env, raw, pay, leaves, alerts, deps };
}

describe('lazy issuance by payer IBAN (§3a)', () => {
  it('three static-QR payments + one receipt payment from the same IBAN → one receipt for all four', async () => {
    const { env, pay, leaves, deps } = setup();
    pay('o1', '2026-10-01T10:00:00Z');
    pay('o2', '2026-10-02T10:00:00Z');
    pay('o3', '2026-10-03T10:00:00Z');
    pay('o4', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });

    const r = await linkReceipts(env, deps);
    expect(r).toEqual({ anchors: 1, lazy: 3, mismatches: 0 });
    expect(leaves()).toEqual([
      { kind: 'direct', sid: ANCHOR_SID, order_id: 'o4', name_mismatch: 0 },
      { kind: 'lazy', sid: ANCHOR_SID, order_id: 'o1', name_mismatch: 0 },
      { kind: 'lazy', sid: ANCHOR_SID, order_id: 'o2', name_mismatch: 0 },
      { kind: 'lazy', sid: ANCHOR_SID, order_id: 'o3', name_mismatch: 0 },
    ]);
    // Idempotent.
    expect(await linkReceipts(env, deps)).toEqual({ anchors: 0, lazy: 0, mismatches: 0 });
  });

  it('covers nothing that is not (yet) the payer\'s delivered payment', async () => {
    const { env, pay, leaves, deps } = setup();
    pay('other-iban', '2026-10-01T10:00:00Z', { iban: 'HR0000000000000000000' });
    pay('rejected', '2026-10-01T11:00:00Z', { state: 'rejected' });
    pay('blocked', '2026-10-01T12:00:00Z', { status: 'blocked' });
    pay('no-iban', '2026-10-01T13:00:00Z', { iban: null });
    pay('later', '2026-10-09T10:00:00Z'); // after the anchor
    pay('offrail', '2026-10-02T10:00:00Z', { status: 'resolved_offrail' });
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });

    await linkReceipts(env, deps);
    expect(leaves().map((l) => `${l.kind}:${l.order_id}`)).toEqual(['direct:anchor', 'lazy:offrail']);
  });

  it('a stray resolved onto a receipt sid is no anchor, but is covered lazily', async () => {
    const { env, pay, leaves, deps } = setup();
    const other = deriveReceiptSid(OWNER, ('0x' + 'ab'.repeat(16)) as Hex);
    pay('stray', '2026-10-01T10:00:00Z', { sid: other, prefix: 'auto' });
    expect(await linkReceipts(env, deps)).toEqual({ anchors: 0, lazy: 0, mismatches: 0 });
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });
    await linkReceipts(env, deps);
    expect(leaves().map((l) => `${l.kind}:${l.order_id}`)).toEqual(['direct:anchor', 'lazy:stray']);
  });

  it('each payment is covered once; a later anchor takes only the gap since the previous one', async () => {
    const { env, pay, leaves, deps } = setup();
    const second = deriveReceiptSid(OWNER, ('0x' + 'cd'.repeat(16)) as Hex);
    pay('a', '2026-10-01T10:00:00Z');
    pay('anchor1', '2026-10-02T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt', status: 'submitted' });
    pay('b', '2026-10-03T10:00:00Z');
    pay('anchor2', '2026-10-04T10:00:00Z', { sid: second, prefix: 'mpt' });

    // anchor2 confirms first: it must NOT take 'a', which belongs to anchor1.
    await linkReceipts(env, deps);
    expect(leaves().map((l) => `${l.kind}:${l.order_id}:${l.sid === second ? 2 : 1}`))
      .toEqual(['direct:anchor2:2', 'lazy:b:2']);
  });

  it('a different payer name on the same IBAN links and alerts (§3a rule 7)', async () => {
    const { env, pay, leaves, alerts, deps } = setup();
    pay('spouse', '2026-10-01T10:00:00Z', { name: 'Ana Horvat' });
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });
    const r = await linkReceipts(env, deps);
    expect(r.mismatches).toBe(1);
    expect(leaves()[1]).toMatchObject({ order_id: 'spouse', name_mismatch: 1 });
    expect(alerts[0]).toContain('isti IBAN');
  });

  it('IBAN formatting does not matter', async () => {
    const { env, pay, leaves, deps } = setup();
    pay('spaced', '2026-10-01T10:00:00Z', { iban: 'hr12 1001 0051 8630 0016 0' });
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt', iban: IBAN });
    await linkReceipts(env, deps);
    expect(leaves()).toHaveLength(2);
  });

  it('name comparison ignores case, diacritics and word order', () => {
    expect(sameHolder('Ivan Horvat', 'HORVAT IVAN')).toBe(true);
    expect(sameHolder('Đuro Čorić', 'djuro coric')).toBe(false); // đ → d, not dj: different spelling alerts
    expect(sameHolder('Đuro Čorić', 'duro coric')).toBe(true);
    expect(sameHolder(null, 'x')).toBe(true);
  });
});

describe('anchoring + OpenTimestamps (§5)', () => {
  it('folds pending leaves into one root, stamps it, proofs verify', async () => {
    const { env, raw, pay, deps } = setup();
    pay('o1', '2026-10-01T10:00:00Z');
    pay('o2', '2026-10-02T10:00:00Z');
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });
    await linkReceipts(env, deps);

    const calls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push(url);
      expect((init.body as Uint8Array).length).toBe(32);
      return new Response(new Uint8Array([0xf0, 0x10, 1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await anchorPendingLeaves(env, { nowUnix: 2_000, fetchImpl: fakeFetch });
    expect(r).toMatchObject({ seq: 1, leaves: 3, calendars: 4 });
    expect(calls.every((u) => u.endsWith('/digest'))).toBe(true);
    expect(await anchorPendingLeaves(env, { fetchImpl: fakeFetch })).toBeNull(); // nothing pending

    const rows = raw.prepare(`SELECT id, leaf_hash, anchor_id FROM receipt_leaves ORDER BY id`).all() as
      Array<{ id: number; leaf_hash: Hex; anchor_id: number }>;
    for (const row of rows) {
      const p = (await proofForLeaf(env, row.id, row.anchor_id))!;
      expect(p.root).toBe(r!.root);
      expect(p.ots_available).toBe(true);
      expect(verifyMerkleProof(row.leaf_hash, p.proof, p.root)).toBe(true);
    }
    const ots = raw.prepare(`SELECT ots FROM receipt_anchors`).get() as { ots: Hex };
    const bytes = hexToBytes(ots.ots);
    expect(new TextDecoder().decode(bytes.slice(1, 15))).toBe('OpenTimestamps');
    // The stamp covers the chain head, not just this batch's root (ADR 0023 §2).
    expect(bytesToHex(bytes.slice(33, 65))).toBe(bytesToHex(await sha256(hexToBytes(r!.chainHead))));
  });

  it('every calendar down → anchor kept without OTS', async () => {
    const { env, raw, pay, deps } = setup();
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });
    await linkReceipts(env, deps);
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await anchorPendingLeaves(env, { fetchImpl: down })).toMatchObject({ calendars: 0 });
    expect(raw.prepare(`SELECT ots FROM receipt_anchors`).get()).toEqual({ ots: null });
  });

  it('OTS file merges several calendars as forks', () => {
    const f = buildOtsFile(new Uint8Array(32), [new Uint8Array([1]), new Uint8Array([2])]);
    expect(Array.from(f.slice(-3))).toEqual([0xff, 1, 2]);
  });
});

// ---- the forward writes the receipt kind into the Payment event ----

const PAYEE = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';

function forwardHarness() {
  const kinds: Array<string | undefined> = [];
  const deps: ForwardDeps = {
    authorize: {
      getIntentBySid: async () => ({ target_address: PAYEE, tenant_id: 'italk', state: 'pending', amount_cents: 500, monerium_order_id: null }),
      getCampaignById: async () => null,
      getTenantStatus: async () => 'active',
      isWhitelisted: async (_t, addr) => addr.toLowerCase() === PAYEE,
      safeAddress: '0x449abcef00000000000000000000000000000000',
      defaultTenantId: 'italk',
      railTenantId: 'italk',
      requireMintAt: null,
      maxForwardCents: null,
    },
    getForwardByOrder: async () => null,
    insertForward: async () => 1,
    updateForward: async () => {},
    forward: async (args) => { kinds.push(args.kind); return { ok: true, txHash: '0xbeef' as Hex }; },
    settleNonRoutedPaid: async () => true,
    pollConfirmation: async () => 'confirmed',
    alert: async () => {},
    audit: async () => {},
    emitBlocked: async () => {},
  } as ForwardDeps;
  return { deps, kinds };
}

const order = (memo: string) =>
  ({ id: 'ord-1', kind: 'issue', state: 'processed', amount: '5.00', currency: 'eur', memo, meta: {} }) as unknown as MoneriumOrder;

describe('forward kind (§3)', () => {
  it('receipt sid in the remittance → rcpt1', async () => {
    const { deps, kinds } = forwardHarness();
    await handleForward(deps, order(`mpt:${PAYEE}?sid=${ANCHOR_SID}`));
    expect(kinds).toEqual(['rcpt1']);
  });

  it('operator reroute onto a receipt sid → rcpt1-unbound', async () => {
    const { deps, kinds } = forwardHarness();
    await handleForward(deps, order(''), { sid: ANCHOR_SID });
    expect(kinds).toEqual(['rcpt1-unbound']);
  });

  it('ordinary sid → registry default', async () => {
    const { deps, kinds } = forwardHarness();
    await handleForward(deps, order(`mpt:${PAYEE}?sid=z232pb646itg`));
    expect(kinds).toEqual([undefined]);
  });
});

// ---- HTTP: public vs owner-signed receipt, intent re-issue ----


describe('receipt API', () => {
  function apiSetup() {
    const s = setup();
    s.raw.prepare(`INSERT INTO tenant_payout_addresses (tenant_id, address, label, source, created_at, created_by)
                   VALUES ('italk', ?, 'payee', 'admin', 0, 'test')`).run(PAYEE);
    const addIntent = (sid: string, state = 'pending') =>
      s.raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, label, created_at, expires_at, tenant_id)
                     VALUES (?, ?, 500, 'eur', ?, 'Članarina', 0, ?, 'italk')`)
        .run(sid, PAYEE, state, Math.floor(Date.now() / 1000) + 600);
    const env = { ...s.env, DEFAULT_TENANT_ID: 'italk', PAYMENT_REGISTRY_ADDRESS: '', GNOSIS_RPC_URL: 'http://127.0.0.1:1' } as unknown as Env;
    const api = buildIntentApi();
    const call = (path: string, init?: RequestInit) => api.request(path, init, env);
    return { ...s, env, addIntent, call };
  }

  async function signed(sid: string, ts = Math.floor(Date.now() / 1000), pk: Hex = PK) {
    const acct = privateKeyToAccount(pk);
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, salt: SALT, ts, signature: await acct.signMessage({ message: receiptRequestMessage(sid, ts) }) }),
    };
  }

  it('public GET shows only the direct payment; the owner sees the lazy ones too', async () => {
    const { pay, addIntent, call } = apiSetup();
    addIntent(ANCHOR_SID, 'paid');
    pay('o1', '2026-10-01T10:00:00Z');
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });

    const pub = await (await call(`/${ANCHOR_SID}/receipt`)).json() as { status: string; payments: Array<{ kind: string }> };
    expect(pub.status).toBe('issued');
    expect(pub.payments.map((p) => p.kind)).toEqual(['direct']);

    const own = await call(`/${ANCHOR_SID}/receipt`, await signed(ANCHOR_SID));
    expect(own.status).toBe(200);
    const body = await own.json() as { payments: Array<{ kind: string }>; owner: string };
    expect(body.payments.map((p) => p.kind).sort()).toEqual(['direct', 'lazy']);
    // Each payment names its own payee (the lazy one may be for another Safe).
    expect((body.payments as unknown as Array<{ target_address: string; tenant_id: string }>)
      .every((p) => p.target_address === '0xpayee' && p.tenant_id === 'italk')).toBe(true);
    expect(body.owner).toBe(OWNER.toLowerCase());
  });

  it('wrong key, stale timestamp, or a non-receipt sid are refused', async () => {
    const { addIntent, call } = apiSetup();
    addIntent(ANCHOR_SID);
    const other = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as Hex;
    expect((await call(`/${ANCHOR_SID}/receipt`, await signed(ANCHOR_SID, undefined, other))).status).toBe(403);
    expect((await call(`/${ANCHOR_SID}/receipt`, await signed(ANCHOR_SID, Math.floor(Date.now() / 1000) - 3600))).status).toBe(403);
    expect((await call(`/z232pb646itg/receipt`)).status).toBe(404);
  });

  it('a pending intent is re-issued under the payer\'s receipt sid', async () => {
    const { addIntent, call, raw } = apiSetup();
    addIntent('z232pb646itg');
    const res = await call('/z232pb646itg/receipt-intent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: ANCHOR_SID }),
    });
    expect(res.status).toBe(201);
    const j = await res.json() as { sid: string; memo: string; amount_cents: number };
    expect(j).toMatchObject({ sid: ANCHOR_SID, amount_cents: 500 });
    expect(j.memo).toContain(`sid=${ANCHOR_SID}`);
    const row = raw.prepare(`SELECT metadata_json, label FROM payment_intents WHERE sid = ?`).get(ANCHOR_SID) as { metadata_json: string; label: string };
    expect(JSON.parse(row.metadata_json)).toEqual({ receipt_of: 'z232pb646itg' });
    expect(row.label).toBe('Članarina');
    // Not a receipt sid → refused; same sid twice → conflict.
    const bad = await call('/z232pb646itg/receipt-intent', { method: 'POST', body: JSON.stringify({ sid: 'abc123' }) });
    expect(bad.status).toBe(400);
    const dup = await call('/z232pb646itg/receipt-intent', { method: 'POST', body: JSON.stringify({ sid: ANCHOR_SID }) });
    expect(dup.status).toBe(409);
  });
});

// ---- ADR 0023 §2: chained anchors, heartbeat, append-only ----

describe('anchor chain (ADR 0023 §2)', () => {
  const quiet = (async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;

  it('each anchor commits to the previous one and to running totals', async () => {
    const { env, raw, pay, deps } = setup();
    pay('o1', '2026-10-01T10:00:00Z');
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });
    await linkReceipts(env, deps);
    const a1 = await anchorPendingLeaves(env, { nowUnix: 10, fetchImpl: quiet });
    const a2 = await anchorPendingLeaves(env, { nowUnix: 20, fetchImpl: quiet, heartbeat: true });
    expect(a1).toMatchObject({ seq: 1, leaves: 2 });
    expect(a2).toMatchObject({ seq: 2, leaves: 0, root: ZERO32 });

    const rows = raw.prepare(`SELECT * FROM receipt_anchors ORDER BY seq`).all() as Array<Record<string, never>>;
    expect(rows[0]).toMatchObject({ prev_chain_head: ZERO32, leaf_count: 2, total_leaves: 2, total_cents: 1000, lazy_count: 1 });
    expect(rows[1]).toMatchObject({ prev_chain_head: a1!.chainHead, leaf_count: 0, total_leaves: 2, total_cents: 1000, lazy_count: 1 });
    for (const r of rows) {
      expect(chainHead({
        prevChainHead: r.prev_chain_head, seq: r.seq, root: r.root, leafCount: r.leaf_count,
        totalLeaves: r.total_leaves, totalCents: r.total_cents, lazyCount: r.lazy_count,
      })).toBe(r.chain_head);
    }
  });

  it('without heartbeat nothing pending means no anchor', async () => {
    const { env } = setup();
    expect(await anchorPendingLeaves(env, { fetchImpl: quiet })).toBeNull();
    expect(await anchorPendingLeaves(env, { fetchImpl: quiet, heartbeat: true })).toMatchObject({ seq: 1 });
  });

  it('leaves and anchors cannot be deleted or rewritten', async () => {
    const { env, raw, pay, deps } = setup();
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });
    await linkReceipts(env, deps);
    expect(() => raw.prepare(`UPDATE receipt_leaves SET amount_cents = 1`).run()).toThrow(/append-only|only anchor_id/);
    expect(() => raw.prepare(`DELETE FROM receipt_leaves`).run()).toThrow(/append-only/);
    await anchorPendingLeaves(env, { fetchImpl: quiet });
    expect(() => raw.prepare(`UPDATE receipt_leaves SET anchor_id = NULL`).run()).toThrow(/only anchor_id/);
    expect(() => raw.prepare(`UPDATE receipt_anchors SET root = '0x01'`).run()).toThrow(/only ots/);
    expect(() => raw.prepare(`DELETE FROM receipt_anchors`).run()).toThrow(/append-only/);
    // An upgraded OTS proof may replace the pending one.
    raw.prepare(`UPDATE receipt_anchors SET ots = '0xabcd' WHERE seq = 1`).run();
  });

  it('public anchor chain API', async () => {
    const { env, pay, deps } = setup();
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });
    await linkReceipts(env, deps);
    await anchorPendingLeaves(env, { fetchImpl: quiet });
    await anchorPendingLeaves(env, { fetchImpl: quiet, heartbeat: true });
    const api = buildReceiptAnchorApi();
    const latest = await (await api.request('/anchors/latest', undefined, env)).json() as { seq: number; ots_available: boolean };
    expect(latest).toMatchObject({ seq: 2, ots_available: true });
    const list = await (await api.request('/anchors?after=0', undefined, env)).json() as { anchors: Array<{ seq: number }> };
    expect(list.anchors.map((a) => a.seq)).toEqual([1, 2]);
    expect((await api.request('/anchors/1.ots', undefined, env)).status).toBe(200);
    expect((await api.request('/anchors/9', undefined, env)).status).toBe(404);
  });
});

// ---- ADR 0023 §3: upgraded .ots pulled back from the public repo, embedded in receipts ----

describe('upgraded OTS pull-back', () => {
  const quiet = (async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
  const BTC = [0x00, 0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01, 0x01, 0x07];

  async function anchored() {
    const s = setup();
    s.pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });
    await linkReceipts(s.env, s.deps);
    const a = await anchorPendingLeaves(s.env, { fetchImpl: quiet });
    return { ...s, head: a!.chainHead };
  }
  const serve = (body: Uint8Array) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  it('takes a Bitcoin-attested proof of the same chain_head and embeds it in the receipt', async () => {
    const { env, raw, head } = await anchored();
    const good = buildOtsFile(await sha256(hexToBytes(head)), [new Uint8Array(BTC)]);
    expect(await pullUpgradedOts(env, { fetchImpl: serve(good) })).toBe(1);
    expect(await pullUpgradedOts(env, { fetchImpl: serve(good) })).toBe(0); // already upgraded
    const leaf = raw.prepare(`SELECT id FROM receipt_leaves`).get() as { id: number };
    const p = (await proofForLeaf(env, leaf.id, 1))!;
    expect(p).toMatchObject({ ots_bitcoin: true, ots: bytesToHex(good) });
  });

  it('ignores a proof for another digest, or one without a Bitcoin attestation', async () => {
    const { env, raw, head } = await anchored();
    const wrong = buildOtsFile(await sha256(hexToBytes(ZERO32)), [new Uint8Array(BTC)]);
    const pending = buildOtsFile(await sha256(hexToBytes(head)), [new Uint8Array([0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, 0x00])]);
    expect(await pullUpgradedOts(env, { fetchImpl: serve(wrong) })).toBe(0);
    expect(await pullUpgradedOts(env, { fetchImpl: serve(pending) })).toBe(0);
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await pullUpgradedOts(env, { fetchImpl: down })).toBe(0);
    const row = raw.prepare(`SELECT ots FROM receipt_anchors WHERE seq = 1`).get() as { ots: string };
    expect(otsHasBitcoin(hexToBytes(row.ots as Hex))).toBe(false);
  });
});

describe('long-used IBAN (first real test covered 73 payments)', () => {
  it('120 earlier payments are linked in batches and every proof matches the per-leaf proof', async () => {
    const { env, raw, pay, deps } = setup();
    for (let i = 0; i < 120; i++) pay(`old${i}`, `2026-09-01T10:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}Z`);
    pay('anchor', '2026-10-04T10:00:00Z', { sid: ANCHOR_SID, prefix: 'mpt' });
    expect(await linkReceipts(env, deps)).toEqual({ anchors: 1, lazy: 120, mismatches: 0 });
    const quiet = (async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
    await anchorPendingLeaves(env, { fetchImpl: quiet });
    const many = await proofsForAnchor(env, 1);
    expect(many.size).toBe(121);
    for (const { id } of raw.prepare(`SELECT id FROM receipt_leaves`).all() as Array<{ id: number }>) {
      expect(many.get(id)).toEqual(await proofForLeaf(env, id, 1));
    }
  });
});
