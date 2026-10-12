import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, type Hex } from 'viem';

import { leafHash } from '../src/receipts/merkle';

/// The verifier replays a .ots proof tree and checks WHEN Bitcoin attested an
/// anchor: a rewritten checkpoint history with freshly stamped proofs is
/// attested long after each anchor's created_at and must fail. Synthetic
/// proofs + a fake Esplora API on 127.0.0.1 (no network).

const VERIFY = join(__dirname, '..', '..', 'scripts', 'mpt_receipt_verify.py');
const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
const CREATED_AT = 1_760_000_000;
const HEIGHT = 900_123;

const OTS_MAGIC = [
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
];
const BITCOIN_TAG = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];
const PENDING_TAG = [0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e];

const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const cat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(parts.flatMap((p) => [...p]));

function varuint(n: number): number[] {
  const out: number[] = [];
  do {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    out.push(n ? b | 0x80 : b);
  } while (n);
  return out;
}
const varbytes = (b: Uint8Array | number[]) => [...varuint(b.length), ...b];

function chainHead(a: { prev: Hex; seq: number; root: Hex; leafCount: number; totalLeaves: number; totalCents: number }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'uint32' },
      { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }],
    [a.prev, BigInt(a.seq), a.root, a.leafCount, BigInt(a.totalLeaves), BigInt(a.totalCents), 0n],
  ));
}

/// The Bitcoin branch: append 16, sha256, prepend 32, sha256, then the
/// attestation. Returns its serialisation and the message at the leaf (the
/// "merkle root" a matching block header must carry).
function bitcoinBranch(digest: Uint8Array, height: number): { bytes: number[]; root: Uint8Array } {
  const suffix = new Uint8Array(16).fill(0xab);
  const prefix = new Uint8Array(32).fill(0xcd);
  const root = sha256(cat(prefix, sha256(cat(digest, suffix))));
  const bytes = [
    0xf0, ...varbytes(suffix), 0x08, 0xf1, ...varbytes(prefix), 0x08,
    0x00, ...BITCOIN_TAG, ...varbytes(varuint(height)),
  ];
  return { bytes, root };
}

function pendingBranch(uri: string): number[] {
  return [0xf0, ...varbytes([1, 2, 3, 4]), 0x08, 0x00, ...PENDING_TAG, ...varbytes(varbytes(new TextEncoder().encode(uri)))];
}

function otsFile(head: Hex, tree: number[]): Uint8Array {
  return cat(OTS_MAGIC, [0x01, 0x08], sha256(hexToBytes(head)), tree);
}

/// Block hash as Esplora shows it: double-SHA256 of the header, reversed.
const hashOf = (header: Uint8Array) => Buffer.from(sha256(sha256(header))).reverse().toString('hex');

/// 80-byte header with the given merkle root and time.
function blockHeader(root: Uint8Array, time: number): Uint8Array {
  const header = new Uint8Array(80);
  header[0] = 0x04;
  header.set(new Uint8Array(32).fill(0x11), 4);
  header.set(root, 36);
  new DataView(header.buffer).setUint32(68, time, true);
  return header;
}

/// Fake Esplora API: height -> header.
const blocks = new Map<number, Uint8Array>();
let server: Server;
let api = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    let m = /^\/block-height\/(\d+)$/.exec(url);
    if (m && blocks.has(Number(m[1]))) {
      res.end(hashOf(blocks.get(Number(m[1]))!));
      return;
    }
    m = /^\/block\/([0-9a-f]{64})\/header$/.exec(url);
    const header = m && [...blocks.values()].find((h) => hashOf(h) === m![1]);
    if (header) {
      res.end(Buffer.from(header).toString('hex'));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/// execFile, not execFileSync: the fake API lives in this process's event loop.
function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('python3', [VERIFY, ...args], { encoding: 'utf8' }, (err, stdout) => {
      resolve({ code: err ? (err.code as number) : 0, out: stdout });
    });
  });
}

function anchor() {
  const a = { prev_chain_head: ZERO32, seq: 1, root: ZERO32, leaf_count: 0, total_leaves: 0, total_cents: 0, lazy_count: 0 };
  return { ...a, chain_head: chainHead({ prev: ZERO32, seq: 1, root: ZERO32, leafCount: 0, totalLeaves: 0, totalCents: 0 }), created_at: CREATED_AT };
}

/// A checkpoint dir with 1.json + 1.ots; the block at HEIGHT gets `time` and
/// (unless `wrongRoot`) the proof's merkle root.
function checkpoints(time: number, opts: { wrongRoot?: boolean; fork?: boolean } = {}): string {
  const a = anchor();
  const digest = sha256(hexToBytes(a.chain_head));
  const btc = bitcoinBranch(digest, HEIGHT);
  const tree = opts.fork ? [0xff, ...pendingBranch('https://alice.btc.calendar.opentimestamps.org'), ...btc.bytes] : btc.bytes;
  blocks.set(HEIGHT, blockHeader(opts.wrongRoot ? new Uint8Array(32).fill(0x22) : btc.root, time));
  const dir = mkdtempSync(join(tmpdir(), 'mpt-verify-btc-'));
  writeFileSync(join(dir, '1.json'), JSON.stringify(a));
  writeFileSync(join(dir, '1.ots'), otsFile(a.chain_head, tree));
  return dir;
}

describe('mpt_receipt_verify.py --btc-api', () => {
  it('an anchor Bitcoin attested 3 h after creation passes', async () => {
    const r = await run('--checkpoints', checkpoints(CREATED_AT + 3 * 3600), '--btc-api', api);
    expect(r.out).toContain(`Bitcoin block ${HEIGHT}`);
    expect(r.out).toContain('ALL CHECKS PASSED');
    expect(r.code).toBe(0);
  });

  it('an anchor Bitcoin attested 5 days after creation is rewritten history', async () => {
    const r = await run('--checkpoints', checkpoints(CREATED_AT + 5 * 86400), '--btc-api', api);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Bitcoin attests anchor #1 only at');
    expect(r.out).toContain('120 h after it was created: rewritten history?');
  });

  it('an attestation earlier than the anchor itself fails', async () => {
    const r = await run('--checkpoints', checkpoints(CREATED_AT - 86400), '--btc-api', api);
    expect(r.code).toBe(1);
    expect(r.out).toContain('BEFORE it was created');
  });

  it('a block whose merkle root is not the proof result fails', async () => {
    const r = await run('--checkpoints', checkpoints(CREATED_AT + 3600, { wrongRoot: true }), '--btc-api', api);
    expect(r.code).toBe(1);
    expect(r.out).toContain('merkle root differs');
  });

  it('a fork with a pending and a Bitcoin branch parses; without --btc-api it is only a note', async () => {
    const dir = checkpoints(CREATED_AT + 3600, { fork: true });
    const off = await run('--checkpoints', dir);
    expect(off.code).toBe(0);
    expect(off.out).toContain(`Bitcoin block ${HEIGHT}: run with --btc-api`);
    const on = await run('--checkpoints', dir, '--btc-api', api);
    expect(on.code).toBe(0);
    expect(on.out).toContain('only one --btc-api given');
  });

  const pendingOnly = (createdAt: number) => {
    const a = { ...anchor(), created_at: createdAt };
    const dir = mkdtempSync(join(tmpdir(), 'mpt-verify-btc-'));
    writeFileSync(join(dir, '1.json'), JSON.stringify(a));
    writeFileSync(join(dir, '1.ots'), otsFile(a.chain_head, pendingBranch('https://bob.btc.calendar.opentimestamps.org')));
    return dir;
  };

  it('a fresh pending-only proof is reported as still pending', async () => {
    const r = await run('--checkpoints', pendingOnly(Math.floor(Date.now() / 1000) - 3600), '--btc-api', api);
    expect(r.code).toBe(0);
    expect(r.out).toContain('still pending');
  });

  it('an anchor older than 72 h with no Bitcoin attestation fails (forged history shows exactly that)', async () => {
    const dir = pendingOnly(Math.floor(Date.now() / 1000) - 5 * 86_400);
    const r = await run('--checkpoints', dir, '--btc-api', api);
    expect(r.code).toBe(1);
    expect(r.out).toContain('older than 72 h');
    // Without --btc-api it stays a note: offline checking cannot judge time.
    expect((await run('--checkpoints', dir)).code).toBe(0);
  });

  it('a receipt with an embedded ots verifies standalone, and a late one fails', async () => {
    const sid = 'r1testtesttesttesttesttest';
    const tx = `0x${'ab'.repeat(32)}`;
    const leaf = leafHash({ kind: 'direct', sid, orderId: 'o1', txHash: tx, amountCents: 500 });
    const fields = { prev_chain_head: ZERO32, seq: 7, root: leaf, leaf_count: 1, total_leaves: 1, total_cents: 500, lazy_count: 0 };
    const head = chainHead({ prev: ZERO32, seq: 7, root: leaf, leafCount: 1, totalLeaves: 1, totalCents: 500 });
    const height = HEIGHT + 7;
    const btc = bitcoinBranch(sha256(hexToBytes(head)), height);
    const receipt = (time: number) => {
      blocks.set(height, blockHeader(btc.root, time));
      return {
        sid,
        payments: [{
          kind: 'direct', order_id: 'o1', tx_hash: tx, amount_cents: 500, leaf_hash: leaf,
          anchor: { ...fields, chain_head: head, proof: [], anchored_at: CREATED_AT, ots: bytesToHex(otsFile(head, btc.bytes)) },
        }],
      };
    };
    const dir = mkdtempSync(join(tmpdir(), 'mpt-verify-btc-'));
    mkdirSync(join(dir, 'r'));
    const p = join(dir, 'r', 'potvrda.json');

    writeFileSync(p, JSON.stringify(receipt(CREATED_AT + 2 * 3600)));
    const ok = await run(p, '--btc-api', api, '--btc-api', api);
    expect(ok.out).toContain(`Bitcoin block ${height}`);
    expect(ok.out).toContain('ALL CHECKS PASSED');
    expect(ok.code).toBe(0);

    writeFileSync(p, JSON.stringify(receipt(CREATED_AT + 3 * 86400)));
    const late = await run(p, '--btc-api', api);
    expect(late.code).toBe(1);
    expect(late.out).toContain('Bitcoin attests anchor #7 only at');
  });
});
