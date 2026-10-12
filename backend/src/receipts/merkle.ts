import { encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';

/// Receipt leaves and the batch Merkle tree (ADR 0022 §3a, §5).
///
/// Tree: sorted-pair keccak256 (OpenZeppelin MerkleProof convention), leaves
/// in insertion order, an odd node is carried up unchanged. A proof is the
/// list of sibling hashes; verification needs no left/right flags.
///
/// Leaves are abi.encode'd with a domain tag so a direct leaf can never be
/// replayed as a lazy one (or vice versa). The Monerium order id is hashed:
/// the leaf names the payment without putting a provider id on any chain.

/// ⚠️ COPIES — change together, with their golden values: scripts/mpt_receipt_verify.py
/// (+ tools/receipt-checkpoints/), energy.domovina.ai lib/receipt-sid.ts and its
/// browser verifier /beta/provjera/ (lib + tests compare against this file).
export const DIRECT_LEAF_DOMAIN = 'MPT-RECEIPT-DIRECT-v1';
export const LAZY_LEAF_DOMAIN = 'MPT-RECEIPT-LAZY-v1';

const ZERO_TX: Hex = `0x${'00'.repeat(32)}`;

export interface LeafInput {
  kind: 'direct' | 'lazy';
  /// The receipt sid; for a lazy leaf, the anchor's sid.
  sid: string;
  orderId: string;
  txHash: string | null;
  amountCents: number;
}

export function leafHash(l: LeafInput): Hex {
  const tx = (l.txHash && /^0x[0-9a-fA-F]{64}$/.test(l.txHash) ? l.txHash.toLowerCase() : ZERO_TX) as Hex;
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
      [
        l.kind === 'direct' ? DIRECT_LEAF_DOMAIN : LAZY_LEAF_DOMAIN,
        l.sid,
        keccak256(toBytes(l.orderId)),
        tx,
        BigInt(l.amountCents),
      ],
    ),
  );
}

function hashPair(a: Hex, b: Hex): Hex {
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(`0x${x.slice(2)}${y.slice(2)}` as Hex);
}

function nextLevel(level: Hex[]): Hex[] {
  const out: Hex[] = [];
  for (let i = 0; i < level.length; i += 2) {
    out.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
  }
  return out;
}

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) throw new Error('empty_tree');
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0];
}

export function merkleProof(leaves: Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new Error('leaf_out_of_range');
  const proof: Hex[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < level.length) proof.push(level[sibling]);
    level = nextLevel(level);
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyMerkleProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
