#!/usr/bin/env python3
"""Independent verifier for MPT payment receipts (ADR 0022, ADR 0023 §4).

Standard library only. Trusts neither MPT nor its website: every hash is
recomputed here from the receipt and the public anchor checkpoints.

  python3 scripts/mpt_receipt_verify.py potvrda.json
  python3 scripts/mpt_receipt_verify.py potvrda.json --checkpoints <mpt-receipts-checkpoints>/anchors
  python3 scripts/mpt_receipt_verify.py --checkpoints anchors/            # the anchor chain alone
  python3 scripts/mpt_receipt_verify.py potvrda.json --rpc https://rpc.gnosischain.com --rpc https://gnosis.drpc.org

Checks
  1. sid  = "r1" + base32(keccak256("MPT-RECEIPT-v1" | owner | salt))[:24]
  2. every payment's leaf hash, recomputed from its fields
  3. every Merkle proof up to its anchor root
  4. every anchor's chain_head, recomputed; with --checkpoints: the same
     chain_head in the public checkpoint and an unbroken chain from seq 1
  5. with --checkpoints: each <seq>.ots stamps sha256(chain_head); reports
     whether it already carries a Bitcoin attestation (verify that one with
     `ots verify`)
  6. with --rpc (two or more recommended): each direct payment's Gnosis tx
     succeeded, and all RPCs agree on its block

Exit code 0 = every check passed, 1 = at least one failed, 2 = bad input.
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.request

# ---------------------------------------------------------------- keccak-256
# Ethereum's keccak256 (original Keccak padding 0x01), not hashlib.sha3_256.

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
]
_M = (1 << 64) - 1


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _keccak_f(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01"
    while len(msg) % rate:
        msg.append(0)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off:off + rate]
        for i in range(rate // 8):
            x, y = i % 5, i // 5
            a[x][y] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        a = _keccak_f(a)
    out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out[:32]


# ---------------------------------------------------------------- encoding

ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
ZERO32 = "0x" + "00" * 32


def hx(s: str) -> bytes:
    s = s[2:] if s.startswith(("0x", "0X")) else s
    return bytes.fromhex(s)


def h0x(b: bytes) -> str:
    return "0x" + b.hex()


def u256(n: int) -> bytes:
    return int(n).to_bytes(32, "big")


def abi_string_tail(s: str) -> bytes:
    raw = s.encode("utf-8")
    pad = (32 - len(raw) % 32) % 32
    return u256(len(raw)) + raw + b"\x00" * pad


def derive_sid(owner: str, salt: str) -> str:
    digest = keccak256(b"MPT-RECEIPT-v1" + hx(owner) + hx(salt))
    bits = "".join(f"{b:08b}" for b in digest)
    return "r1" + "".join(ALPHABET[int(bits[5 * i:5 * i + 5], 2)] for i in range(24))


def leaf_hash(kind: str, sid: str, order_id: str, tx_hash, amount_cents: int) -> str:
    domain = "MPT-RECEIPT-DIRECT-v1" if kind == "direct" else "MPT-RECEIPT-LAZY-v1"
    tx = tx_hash.lower() if isinstance(tx_hash, str) and len(tx_hash) == 66 else ZERO32
    t1, t2 = abi_string_tail(domain), abi_string_tail(sid)
    head = u256(5 * 32) + u256(5 * 32 + len(t1)) + keccak256(order_id.encode()) + hx(tx) + u256(amount_cents)
    return h0x(keccak256(head + t1 + t2))


def chain_head(a: dict) -> str:
    enc = (hx(a["prev_chain_head"]) + u256(a["seq"]) + hx(a["root"]) + u256(a["leaf_count"])
           + u256(a["total_leaves"]) + u256(a["total_cents"]) + u256(a["lazy_count"]))
    return h0x(keccak256(enc))


def merkle_apply(leaf: str, proof) -> str:
    h = leaf.lower()
    for p in proof:
        x, y = sorted([h, p.lower()])
        h = h0x(keccak256(hx(x) + hx(y)))
    return h


# ---------------------------------------------------------------- OTS

OTS_MAGIC = b"\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94"
BITCOIN_TAG = bytes.fromhex("0588960d73d71901")
PENDING_TAG = bytes.fromhex("83dfe30d2ef90c8e")


def check_ots(path: str, head: str):
    data = open(path, "rb").read()
    if not data.startswith(OTS_MAGIC) or data[len(OTS_MAGIC)] != 1 or data[len(OTS_MAGIC) + 1] != 0x08:
        return "not a SHA256 OpenTimestamps proof", None
    digest = data[len(OTS_MAGIC) + 2:len(OTS_MAGIC) + 34]
    if digest != hashlib.sha256(hx(head)).digest():
        return "stamps a different digest than sha256(chain_head)", None
    return None, BITCOIN_TAG in data


# ---------------------------------------------------------------- RPC


def rpc_receipt(url: str, tx: str):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionReceipt", "params": [tx]}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": "mpt-receipt-verify"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get("result")


# ---------------------------------------------------------------- main


def load_checkpoints(directory: str):
    anchors = {}
    for name in os.listdir(directory):
        if name.endswith(".json") and name[:-5].isdigit():
            a = json.load(open(os.path.join(directory, name), encoding="utf-8"))
            anchors[int(a["seq"])] = a
    return anchors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("receipt", nargs="?", help="receipt JSON (download from the receipt page or POST /receipt)")
    ap.add_argument("--checkpoints", help="directory with <seq>.json (+ <seq>.ots) anchor checkpoints")
    ap.add_argument("--rpc", action="append", default=[], help="Gnosis JSON-RPC URL (repeat for independent nodes)")
    args = ap.parse_args()
    if not args.receipt and not args.checkpoints:
        ap.print_usage()
        return 2

    errors, notes = [], []
    receipt_anchors = {}

    if args.receipt:
        try:
            rc = json.load(open(args.receipt, encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"cannot read receipt: {e}")
            return 2
        sid = rc.get("sid", "")
        owner, salt = rc.get("owner"), rc.get("salt")
        if owner and salt:
            if derive_sid(owner, salt) != sid:
                errors.append(f"sid {sid} is not derived from owner {owner} and salt {salt}")
            else:
                notes.append(f"sid {sid} commits to owner {owner}")
        else:
            notes.append("receipt has no owner/salt (public view): owner binding not checked")

        for i, p in enumerate(rc.get("payments", []), 1):
            where = f"payment {i} ({p.get('kind')}, order {p.get('order_id')})"
            lh = leaf_hash(p["kind"], sid, p["order_id"], p.get("tx_hash"), int(p["amount_cents"]))
            if lh != p.get("leaf_hash", "").lower():
                errors.append(f"{where}: leaf hash does not match its fields")
                continue
            a = p.get("anchor")
            if not a:
                notes.append(f"{where}: not anchored yet")
                continue
            if merkle_apply(lh, a["proof"]) != a["root"].lower():
                errors.append(f"{where}: Merkle proof does not reach root of anchor #{a['seq']}")
            if chain_head(a) != a["chain_head"].lower():
                errors.append(f"{where}: anchor #{a['seq']} chain_head does not match its fields")
            receipt_anchors[int(a["seq"])] = a

        if args.rpc:
            for p in rc.get("payments", []):
                tx = p.get("tx_hash")
                if p.get("kind") != "direct" or not tx:
                    continue
                blocks = set()
                for url in args.rpc:
                    try:
                        r = rpc_receipt(url, tx)
                    except Exception as e:  # noqa: BLE001 — report, do not crash
                        errors.append(f"tx {tx}: RPC {url} failed: {e}")
                        continue
                    if not r or r.get("status") != "0x1":
                        errors.append(f"tx {tx}: not a successful transaction according to {url}")
                    else:
                        blocks.add(r.get("blockHash"))
                if len(blocks) > 1:
                    errors.append(f"tx {tx}: RPCs disagree on its block")
                elif len(args.rpc) < 2:
                    notes.append("only one RPC given: a single node is trusted for the tx check")

    if args.checkpoints:
        cps = load_checkpoints(args.checkpoints)
        if not cps:
            errors.append(f"no <seq>.json checkpoints in {args.checkpoints}")
        prev = ZERO32
        for seq in range(1, max(cps or [0]) + 1):
            a = cps.get(seq)
            if a is None:
                errors.append(f"checkpoint #{seq} is missing: the chain has a gap")
                prev = None
                continue
            if prev is not None and a["prev_chain_head"].lower() != prev:
                errors.append(f"checkpoint #{seq} does not continue #{seq - 1}")
            if chain_head(a) != a["chain_head"].lower():
                errors.append(f"checkpoint #{seq} chain_head does not match its fields")
            prev = a["chain_head"].lower()
            ots = os.path.join(args.checkpoints, f"{seq}.ots")
            if os.path.exists(ots):
                err, btc = check_ots(ots, a["chain_head"])
                if err:
                    errors.append(f"checkpoint #{seq}: {ots}: {err}")
                elif not btc:
                    notes.append(f"checkpoint #{seq}: .ots still pending (no Bitcoin attestation yet)")
            else:
                notes.append(f"checkpoint #{seq}: no .ots file")
        for seq, a in receipt_anchors.items():
            cp = cps.get(seq)
            if cp is None:
                errors.append(f"receipt anchor #{seq} is not in the public checkpoints")
            elif cp["chain_head"].lower() != a["chain_head"].lower():
                errors.append(f"receipt anchor #{seq} differs from the public checkpoint")
        if cps:
            notes.append(f"anchor chain #1..#{max(cps)} checked")

    for n in notes:
        print(f"  · {n}")
    if errors:
        print(f"{len(errors)} CHECK(S) FAILED:")
        for e in errors:
            print(f"  ✗ {e}")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
