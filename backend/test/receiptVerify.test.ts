import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { buildIntentApi } from '../src/intents/api';
import { receiptRequestMessage } from '../src/receipts/api';
import { anchorPendingLeaves } from '../src/receipts/anchor';
import { linkReceipts } from '../src/receipts/link';
import { buildReceiptAnchorApi } from '../src/receipts/routes';
import { deriveReceiptSid } from '../src/receipts/sid';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

/// ADR 0023 §4: the stdlib verifier accepts a real receipt + checkpoints and
/// rejects every tampered variant (the same test in both directions as
/// maksimir_verify.py).

const VERIFY = join(__dirname, '..', '..', 'scripts', 'mpt_receipt_verify.py');
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const ACCOUNT = privateKeyToAccount(PK);
const SALT = '0x000102030405060708090a0b0c0d0e0f' as Hex;
const SID = deriveReceiptSid(ACCOUNT.address, SALT);
const PAYEE = '0x4f7f1950b2cb6713ccb47b869f30c0ebc01d0173';

function run(...args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('python3', [VERIFY, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

async function fixture() {
  const { db, raw } = migratedD1();
  const env = { DB: db, DEFAULT_TENANT_ID: 'italk', PAYMENT_REGISTRY_ADDRESS: '', GNOSIS_RPC_URL: 'http://127.0.0.1:1' } as unknown as Env;
  raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, currency, state, created_at, expires_at, tenant_id)
               VALUES (?, ?, 500, 'eur', 'paid', 0, 9999999999, 'italk')`).run(SID, PAYEE);
  const pay = (id: string, placedAt: string, sid: string | null, prefix: string, n: number) => {
    raw.prepare(`INSERT INTO monerium_orders (id, kind, state, amount, currency, counterpart_iban, counterpart_name, tx_hashes, placed_at, raw_json, updated_at)
                 VALUES (?, 'issue', 'processed', '5.00', 'eur', 'HR1210010051863000160', 'Ivan Horvat', ?, ?, '{}', 0)`)
      .run(id, JSON.stringify([`0x${String(n).repeat(64)}`]), placedAt);
    raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, memo_prefix, status, tx_hash, attempts, created_at, updated_at)
                 VALUES (?, ?, '0', 500, ?, ?, 'confirmed', ?, 1, 0, 0)`).run(id, PAYEE, sid, prefix, `0x${String(n + 1).repeat(64)}`);
  };
  pay('o1', '2026-10-01T10:00:00Z', null, 'cmp', 1);
  pay('o2', '2026-10-02T10:00:00Z', null, 'cmp', 3);
  pay('o3', '2026-10-03T10:00:00Z', SID, 'mpt', 5);
  await linkReceipts(env, { alert: async () => {} });
  const ok = (async () => new Response(new Uint8Array([0xf0, 1]), { status: 200 })) as unknown as typeof fetch;
  await anchorPendingLeaves(env, { fetchImpl: ok, heartbeat: true });
  await anchorPendingLeaves(env, { fetchImpl: ok, heartbeat: true }); // empty heartbeat after it

  const ts = Math.floor(Date.now() / 1000);
  const signature = await ACCOUNT.signMessage({ message: receiptRequestMessage(SID, ts) });
  const res = await buildIntentApi().request(`/${SID}/receipt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: ACCOUNT.address, salt: SALT, ts, signature }),
  }, env);
  const receipt = await res.json() as Record<string, unknown> & { payments: Array<Record<string, unknown>> };
  expect(receipt.payments).toHaveLength(3);

  const dir = mkdtempSync(join(tmpdir(), 'mpt-verify-'));
  const cps = join(dir, 'anchors');
  execFileSync('mkdir', [cps]);
  const anchorsApi = buildReceiptAnchorApi();
  const list = await (await anchorsApi.request('/anchors?after=0', undefined, env)).json() as { anchors: Array<{ seq: number }> };
  for (const a of list.anchors) {
    writeFileSync(join(cps, `${a.seq}.json`), JSON.stringify(a));
    const ots = await anchorsApi.request(`/anchors/${a.seq}.ots`, undefined, env);
    writeFileSync(join(cps, `${a.seq}.ots`), new Uint8Array(await ots.arrayBuffer()));
  }
  const write = (r: unknown, name = 'potvrda.json') => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(r));
    return p;
  };
  return { receipt, cps, write };
}

describe('mpt_receipt_verify.py', () => {
  it('a genuine receipt with its public checkpoints passes', async () => {
    const { receipt, cps, write } = await fixture();
    const r = run(write(receipt), '--checkpoints', cps);
    expect(r.out).toContain('ALL CHECKS PASSED');
    expect(r.code).toBe(0);
  });

  it('the checkpoint chain alone passes', async () => {
    const { cps } = await fixture();
    expect(run('--checkpoints', cps).code).toBe(0);
  });

  it('a changed amount, a foreign owner, or a forged anchor fails', async () => {
    const { receipt, cps, write } = await fixture();
    const amount = structuredClone(receipt);
    amount.payments[0].amount_cents = 50_000;
    const a = run(write(amount, 'a.json'), '--checkpoints', cps);
    expect(a.code).toBe(1);
    expect(a.out).toContain('leaf hash does not match');

    const owner = { ...structuredClone(receipt), owner: '0x' + '11'.repeat(20) };
    expect(run(write(owner, 'b.json')).out).toContain('is not derived from owner');

    const anchor = structuredClone(receipt);
    (anchor.payments[0].anchor as Record<string, unknown>).total_cents = 1;
    const c = run(write(anchor, 'c.json'), '--checkpoints', cps);
    expect(c.code).toBe(1);
    expect(c.out).toContain('chain_head does not match');
  });

  it('a checkpoint dropped from the public chain is a gap', async () => {
    const { cps } = await fixture();
    execFileSync('rm', [join(cps, '1.json')]);
    const r = run('--checkpoints', cps);
    expect(r.code).toBe(1);
    expect(r.out).toContain('missing');
  });
});

it('the checkpoint repo template carries the same verifier', () => {
  const copy = join(__dirname, '..', '..', 'tools', 'receipt-checkpoints', 'mpt_receipt_verify.py');
  expect(readFileSync(copy, 'utf8')).toBe(readFileSync(VERIFY, 'utf8'));
});
