import { encodeAbiParameters, hexToBytes, keccak256, toHex, type Hex } from 'viem';

import type { Env } from '../types';
import { merkleProof, merkleRoot } from './merkle';

/// Batch anchoring (ADR 0022 §5, ADR 0023 §2): every not-yet-anchored leaf goes
/// into one Merkle root; the anchor chains to the previous one (chain_head) and
/// sha256(chain_head) is stamped on OpenTimestamps (Bitcoin). The Gnosis anchor
/// contract (ADR 0023 §5) is not deployed yet — chain_tx_hash stays NULL.

export const OTS_CALENDARS = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
];

/// OpenTimestamps detached-proof header: magic, major version 1, then the
/// file-hash op (0x08 = SHA256) and the 32-byte digest of the stamped file.
const OTS_MAGIC = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
  0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const OTS_VERSION = 0x01;
const OP_SHA256 = 0x08;
const FORK = 0xff;

/// A `.ots` file for a 32-byte file whose sha256 is `digest`. Each calendar
/// answers with a serialised timestamp of that digest; several are merged as
/// forks (0xff before every branch but the last), as the reference client does.
export function buildOtsFile(digest: Uint8Array, calendarResponses: Uint8Array[]): Uint8Array {
  if (calendarResponses.length === 0) throw new Error('no_calendar_responses');
  const parts: number[] = [...OTS_MAGIC, OTS_VERSION, OP_SHA256, ...digest];
  calendarResponses.forEach((r, i) => {
    if (i < calendarResponses.length - 1) parts.push(FORK);
    parts.push(...r);
  });
  return new Uint8Array(parts);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/// POST the digest to every calendar; keep whatever answers. Never throws.
export async function stampOts(
  digest: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ots: Uint8Array | null; calendars: string[] }> {
  const answers = await Promise.all(OTS_CALENDARS.map(async (cal) => {
    try {
      const res = await fetchImpl(`${cal}/digest`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.opentimestamps.v1',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'mpt-receipts',
        },
        body: digest,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = new Uint8Array(await res.arrayBuffer());
      return body.length > 0 && body.length < 10_000 ? { cal, body } : null;
    } catch {
      return null;
    }
  }));
  const ok = answers.flatMap((a) => (a ? [a] : []));
  if (ok.length === 0) return { ots: null, calendars: [] };
  return { ots: buildOtsFile(digest, ok.map((a) => a.body)), calendars: ok.map((a) => a.cal) };
}

export const ZERO32: Hex = `0x${'00'.repeat(32)}`;

/// ADR 0023 §2: every anchor commits to the previous one and to running
/// totals, so dropping or rewriting any earlier anchor changes every later
/// chain_head. abi.encode so a Solidity contract can recompute it.
export function chainHead(a: {
  prevChainHead: Hex;
  seq: number;
  root: Hex;
  leafCount: number;
  totalLeaves: number;
  totalCents: number;
  lazyCount: number;
}): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'uint32' },
      { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }],
    [a.prevChainHead, BigInt(a.seq), a.root, a.leafCount, BigInt(a.totalLeaves), BigInt(a.totalCents), BigInt(a.lazyCount)],
  ));
}

export interface AnchorRow {
  seq: number;
  prev_chain_head: Hex;
  chain_head: Hex;
  root: Hex;
  leaf_count: number;
  total_leaves: number;
  total_cents: number;
  lazy_count: number;
  ots: string | null;
  ots_calendars: string | null;
  chain_tx_hash: string | null;
  created_at: number;
}

const ANCHOR_COLS = `seq, prev_chain_head, chain_head, root, leaf_count, total_leaves, total_cents,
  lazy_count, ots, ots_calendars, chain_tx_hash, created_at`;

export async function latestAnchor(env: Env): Promise<AnchorRow | null> {
  return env.DB.prepare(`SELECT ${ANCHOR_COLS} FROM receipt_anchors ORDER BY seq DESC LIMIT 1`).first<AnchorRow>();
}

export async function getAnchor(env: Env, seq: number): Promise<AnchorRow | null> {
  return env.DB.prepare(`SELECT ${ANCHOR_COLS} FROM receipt_anchors WHERE seq = ?`).bind(seq).first<AnchorRow>();
}

export async function listAnchors(env: Env, after: number, limit = 100): Promise<AnchorRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ${ANCHOR_COLS} FROM receipt_anchors WHERE seq > ? ORDER BY seq LIMIT ?`,
  ).bind(after, limit).all<AnchorRow>();
  return rows.results;
}

export interface AnchorResult {
  seq: number;
  chainHead: Hex;
  root: Hex;
  leaves: number;
  calendars: number;
}

/// Fold every pending leaf into the next anchor. With `heartbeat` an anchor is
/// made even when nothing is pending (the daily tick: "nothing changed" is
/// itself stamped). Returns null when there is nothing to do or a concurrent
/// run took this seq.
export async function anchorPendingLeaves(
  env: Env,
  opts: { nowUnix?: number; fetchImpl?: typeof fetch; maxLeaves?: number; heartbeat?: boolean } = {},
): Promise<AnchorResult | null> {
  const now = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    `SELECT id, leaf_hash, amount_cents, kind FROM receipt_leaves WHERE anchor_id IS NULL ORDER BY id LIMIT ?`,
  ).bind(opts.maxLeaves ?? 4096).all<{ id: number; leaf_hash: string; amount_cents: number; kind: string }>();
  const leaves = rows.results;
  if (leaves.length === 0 && !opts.heartbeat) return null;

  const prev = await latestAnchor(env);
  const seq = (prev?.seq ?? 0) + 1;
  const root = leaves.length > 0 ? merkleRoot(leaves.map((l) => l.leaf_hash as Hex)) : ZERO32;
  const head = {
    prevChainHead: (prev?.chain_head ?? ZERO32) as Hex,
    seq,
    root,
    leafCount: leaves.length,
    totalLeaves: (prev?.total_leaves ?? 0) + leaves.length,
    totalCents: (prev?.total_cents ?? 0) + leaves.reduce((s, l) => s + l.amount_cents, 0),
    lazyCount: (prev?.lazy_count ?? 0) + leaves.filter((l) => l.kind === 'lazy').length,
  };
  const ch = chainHead(head);

  // One transaction: the anchor row (seq is the latch) and its leaves. The
  // leaf UPDATE only fires if THIS run's row won the seq.
  const ids = leaves.map((l) => l.id);
  const stmts = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO receipt_anchors
         (seq, prev_chain_head, chain_head, root, leaf_count, total_leaves, total_cents, lazy_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(seq, head.prevChainHead, ch, root, head.leafCount, head.totalLeaves, head.totalCents, head.lazyCount, now),
  ];
  if (ids.length > 0) {
    stmts.push(env.DB.prepare(
      `UPDATE receipt_leaves SET anchor_id = ?1
        WHERE anchor_id IS NULL AND id >= ?2 AND id <= ?3
          AND (SELECT chain_head FROM receipt_anchors WHERE seq = ?1) = ?4`,
    ).bind(seq, ids[0], ids[ids.length - 1], ch));
  }
  await env.DB.batch(stmts);
  const won = await getAnchor(env, seq);
  if (!won || won.chain_head !== ch) return null;

  const stamp = await stampOts(await sha256(hexToBytes(ch)), opts.fetchImpl);
  if (stamp.ots) {
    await env.DB.prepare(`UPDATE receipt_anchors SET ots = ?, ots_calendars = ? WHERE seq = ?`)
      .bind(toHex(stamp.ots), JSON.stringify(stamp.calendars), seq).run();
  }
  return { seq, chainHead: ch, root, leaves: leaves.length, calendars: stamp.calendars.length };
}

export interface LeafProof {
  anchor_id: number;
  seq: number;
  root: Hex;
  proof: Hex[];
  prev_chain_head: Hex;
  chain_head: Hex;
  leaf_count: number;
  total_leaves: number;
  total_cents: number;
  lazy_count: number;
  ots_available: boolean;
  anchored_at: number;
}

/// Inclusion proof for one leaf, rebuilt from the anchor's leaves (id order),
/// with everything needed to recompute the anchor's chain_head offline.
export async function proofForLeaf(env: Env, leafId: number, seq: number): Promise<LeafProof | null> {
  const anchor = await getAnchor(env, seq);
  if (!anchor) return null;
  const rows = await env.DB.prepare(
    `SELECT id, leaf_hash FROM receipt_leaves WHERE anchor_id = ? ORDER BY id`,
  ).bind(seq).all<{ id: number; leaf_hash: string }>();
  const hashes = rows.results.map((r) => r.leaf_hash as Hex);
  const index = rows.results.findIndex((r) => r.id === leafId);
  if (index < 0) return null;
  return {
    anchor_id: anchor.seq,
    seq: anchor.seq,
    root: anchor.root,
    proof: merkleProof(hashes, index),
    prev_chain_head: anchor.prev_chain_head,
    chain_head: anchor.chain_head,
    leaf_count: anchor.leaf_count,
    total_leaves: anchor.total_leaves,
    total_cents: anchor.total_cents,
    lazy_count: anchor.lazy_count,
    ots_available: anchor.ots !== null,
    anchored_at: anchor.created_at,
  };
}
