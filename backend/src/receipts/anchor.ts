import { hexToBytes, toHex, type Hex } from 'viem';

import type { Env } from '../types';
import { merkleProof, merkleRoot } from './merkle';

/// Batch anchoring (ADR 0022 §5): every not-yet-anchored leaf goes into one
/// Merkle root; the root is stamped on OpenTimestamps (Bitcoin). Recording the
/// root in PaymentRegistry waits for the registry deploy (safe-tx/004) — until
/// then chain_tx_hash stays NULL and OTS is the independent anchor.

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

export interface AnchorResult {
  anchorId: number;
  root: Hex;
  leaves: number;
  calendars: number;
}

/// Fold every pending leaf into one anchor. Returns null when nothing waits.
export async function anchorPendingLeaves(
  env: Env,
  opts: { nowUnix?: number; fetchImpl?: typeof fetch; maxLeaves?: number } = {},
): Promise<AnchorResult | null> {
  const now = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    `SELECT id, leaf_hash FROM receipt_leaves WHERE anchor_id IS NULL ORDER BY id LIMIT ?`,
  ).bind(opts.maxLeaves ?? 4096).all<{ id: number; leaf_hash: string }>();
  const leaves = rows.results;
  if (leaves.length === 0) return null;
  const root = merkleRoot(leaves.map((l) => l.leaf_hash as Hex));

  // The UNIQUE root is the latch: a concurrent run over the same leaves loses.
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO receipt_anchors (root, leaf_count, created_at) VALUES (?, ?, ?)`,
  ).bind(root, leaves.length, now).run();
  if ((ins.meta?.changes ?? 0) === 0) return null;
  const anchorId = Number(ins.meta.last_row_id);
  const ids = leaves.map((l) => l.id);
  await env.DB.prepare(
    `UPDATE receipt_leaves SET anchor_id = ? WHERE anchor_id IS NULL AND id >= ? AND id <= ?`,
  ).bind(anchorId, ids[0], ids[ids.length - 1]).run();

  const stamp = await stampOts(await sha256(hexToBytes(root)), opts.fetchImpl);
  if (stamp.ots) {
    await env.DB.prepare(`UPDATE receipt_anchors SET ots = ?, ots_calendars = ? WHERE id = ?`)
      .bind(toHex(stamp.ots), JSON.stringify(stamp.calendars), anchorId).run();
  }
  return { anchorId, root, leaves: leaves.length, calendars: stamp.calendars.length };
}

export interface LeafProof {
  anchor_id: number;
  root: Hex;
  proof: Hex[];
  ots_available: boolean;
  anchored_at: number;
}

/// Inclusion proof for one leaf, rebuilt from the anchor's leaves (id order).
export async function proofForLeaf(env: Env, leafId: number, anchorId: number): Promise<LeafProof | null> {
  const anchor = await env.DB.prepare(`SELECT id, root, ots, created_at FROM receipt_anchors WHERE id = ?`)
    .bind(anchorId).first<{ id: number; root: string; ots: string | null; created_at: number }>();
  if (!anchor) return null;
  const rows = await env.DB.prepare(
    `SELECT id, leaf_hash FROM receipt_leaves WHERE anchor_id = ? ORDER BY id`,
  ).bind(anchorId).all<{ id: number; leaf_hash: string }>();
  const hashes = rows.results.map((r) => r.leaf_hash as Hex);
  const index = rows.results.findIndex((r) => r.id === leafId);
  if (index < 0) return null;
  return {
    anchor_id: anchor.id,
    root: anchor.root as Hex,
    proof: merkleProof(hashes, index),
    ots_available: anchor.ots !== null,
    anchored_at: anchor.created_at,
  };
}
