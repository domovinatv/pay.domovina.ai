import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import { linkReceipts } from '../src/receipts/link';
import { deriveReceiptSid } from '../src/receipts/sid';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

// ADR 0025: in direct mode the payer's remittance is `gnosis:<Safe> sid:<sid>`
// (`chiado:` on sandbox). It carries the sid exactly like `mpt:` did, so a
// confirmed forward with that prefix is a receipt anchor. A stray resolved by
// amount and time ('auto') still is not.

const OWNER = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex).address;
const SID = deriveReceiptSid(OWNER, '0x000102030405060708090a0b0c0d0e0f' as Hex);

function setup() {
  const { db, raw } = migratedD1();
  const env = { DB: db } as unknown as Env;
  const pay = (id: string, prefix: string, status = 'confirmed') => {
    raw.prepare(
      `INSERT INTO monerium_orders (id, kind, state, amount, currency, counterpart_iban, counterpart_name,
         tx_hashes, placed_at, raw_json, updated_at, tenant_id)
       VALUES (?, 'issue', 'processed', '1', 'eur', 'LT11 3250 0838 5916 5625', 'Ivan Horvat', ?, '2026-10-15T21:00:00Z', '{}', 0, 'italk')`,
    ).run(id, JSON.stringify([`0x${'a'.repeat(64)}`]));
    raw.prepare(
      `INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, memo_prefix, status,
         tx_hash, attempts, created_at, updated_at, tenant_id)
       VALUES (?, '0xproject', '0', 100, ?, ?, ?, NULL, 1, 0, 0, 'italk')`,
    ).run(id, SID, prefix, status);
  };
  const leaves = () => raw.prepare(`SELECT kind, order_id FROM receipt_leaves`).all() as Array<{ kind: string; order_id: string }>;
  const deps = { alert: async () => {}, nowUnix: () => 1_000 };
  return { env, pay, leaves, deps };
}

describe('receipt anchors in direct mode (ADR 0025)', () => {
  for (const prefix of ['gnosis', 'chiado']) {
    it(`a confirmed ${prefix}: payment with the receipt sid is an anchor`, async () => {
      const { env, pay, leaves, deps } = setup();
      pay('o1', prefix);
      expect(await linkReceipts(env, deps)).toEqual({ anchors: 1, lazy: 0, mismatches: 0 });
      expect(leaves()).toEqual([{ kind: 'direct', order_id: 'o1' }]);
    });
  }

  it('a stray bound by amount and time is still no anchor', async () => {
    const { env, pay, deps } = setup();
    pay('o1', 'auto');
    expect(await linkReceipts(env, deps)).toEqual({ anchors: 0, lazy: 0, mismatches: 0 });
  });

  it('an owed direct payment becomes an anchor only once the owners\' transfer confirms it', async () => {
    const { env, pay, deps } = setup();
    pay('o1', 'gnosis', 'pending');
    expect(await linkReceipts(env, deps)).toEqual({ anchors: 0, lazy: 0, mismatches: 0 });
  });
});
