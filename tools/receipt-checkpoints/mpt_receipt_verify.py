#!/usr/bin/env python3
"""Independent verifier for MPT payment receipts (ADR 0022, ADR 0023 §4).

Standard library only. Trusts neither MPT nor its website: every hash is
recomputed here from the receipt and the public anchor checkpoints.

  python3 scripts/mpt_receipt_verify.py potvrda.json
  python3 scripts/mpt_receipt_verify.py potvrda.json --checkpoints <mpt-receipts-checkpoints>/anchors
  python3 scripts/mpt_receipt_verify.py --checkpoints anchors/            # the anchor chain alone
  python3 scripts/mpt_receipt_verify.py potvrda.json --rpc https://rpc.gnosischain.com --rpc https://gnosis.drpc.org
  python3 scripts/mpt_receipt_verify.py --checkpoints anchors/ --btc-api https://mempool.space/api --btc-api https://blockstream.info/api

Checks
  1. sid  = "r1" + base32(keccak256("MPT-RECEIPT-v1" | owner | salt))[:24]
  2. every payment's leaf hash, recomputed from its fields
  3. every Merkle proof up to its anchor root
  4. every anchor's chain_head, recomputed; with --checkpoints: the same
     chain_head in the public checkpoint and an unbroken chain from seq 1
  5. each OpenTimestamps proof (<seq>.ots with --checkpoints, or `ots`
     embedded in a receipt's anchor) stamps sha256(chain_head); its proof
     tree is replayed op by op and every Bitcoin attestation is collected
  6. with --btc-api (two or more recommended): each attested block header is
     fetched, hashed to its block hash, and must carry the proof's result as
     its merkle root; the earliest such block time must lie within
     [created_at - 2 h, created_at + 48 h]. A later time means the anchor
     was stamped long after it claims to exist: rewritten history
  7. with --rpc (two or more recommended): each direct payment's Gnosis tx
     succeeded, and all RPCs agree on its block

Exit code 0 = every check passed, 1 = at least one failed, 2 = bad input.
"""

import argparse
import datetime
import hashlib
import json
import os
import sys
import time
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
# OpenTimestamps detached proof, parsed as python-opentimestamps does: header,
# file digest, then a tree of ops (each applied to the message so far) whose
# leaves are attestations. A Bitcoin attestation at height h says: the message
# at this leaf is the merkle root of Bitcoin block h.

OTS_MAGIC = b"\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94"
BITCOIN_TAG = bytes.fromhex("0588960d73d71901")
PENDING_TAG = bytes.fromhex("83dfe30d2ef90c8e")
OTS_MAX_FILE = 1 << 20     # real proofs are a few kB
OTS_MAX_DEPTH = 256        # ops along one path (a Bitcoin proof has ~60)
OTS_MAX_VARBYTES = 8192

_UNARY = {0x02: "sha1", 0x03: "ripemd160", 0x08: "sha256", 0x67: "keccak256", 0xF2: "reverse", 0xF3: "hexlify"}


class OtsError(ValueError):
    pass


class _Reader:
    def __init__(self, data: bytes):
        self.data, self.pos = data, 0

    def bytes(self, n: int) -> bytes:
        if self.pos + n > len(self.data):
            raise OtsError("truncated")
        out = self.data[self.pos:self.pos + n]
        self.pos += n
        return out

    def byte(self) -> int:
        return self.bytes(1)[0]

    def varuint(self) -> int:
        # LEB128: 7 bits per byte, least significant first, high bit = more
        value, shift = 0, 0
        while True:
            b = self.byte()
            value |= (b & 0x7F) << shift
            if not b & 0x80:
                return value
            shift += 7
            if shift > 63:
                raise OtsError("varuint too long")

    def varbytes(self) -> bytes:
        n = self.varuint()
        if n > OTS_MAX_VARBYTES:
            raise OtsError(f"varbytes of {n} bytes")
        return self.bytes(n)


def _apply_unary(name: str, msg):
    """None = this branch cannot be computed here (no ripemd160 in this Python)."""
    if msg is None:
        return None
    if name == "reverse":
        return msg[::-1]
    if name == "hexlify":
        return msg.hex().encode()
    if name == "keccak256":
        return keccak256(msg)
    try:
        return hashlib.new(name, msg).digest()
    except ValueError:
        return None


def _ots_timestamp(r: _Reader, msg, depth: int, out: dict):
    if depth > OTS_MAX_DEPTH:
        raise OtsError("proof tree too deep")

    def handle(tag: int):
        if tag == 0x00:
            att_tag, payload = r.bytes(8), r.varbytes()
            if att_tag == BITCOIN_TAG:
                height = _Reader(payload).varuint()
                if msg is None:
                    out["unverifiable"].append(height)
                else:
                    out["bitcoin"].append((height, msg))
            elif att_tag == PENDING_TAG:
                out["pending"].append(_Reader(payload).varbytes().decode("utf-8", "replace"))
            else:
                out["unknown"].append(att_tag.hex())
            return
        if tag in _UNARY:
            nxt = _apply_unary(_UNARY[tag], msg)
        elif tag in (0xF0, 0xF1):
            arg = r.varbytes()
            nxt = None if msg is None else (msg + arg if tag == 0xF0 else arg + msg)
        else:
            raise OtsError(f"unknown op 0x{tag:02x}")
        _ots_timestamp(r, nxt, depth + 1, out)

    tag = r.byte()
    while tag == 0xFF:  # fork: every branch but the last is prefixed with 0xff
        handle(r.byte())
        tag = r.byte()
    handle(tag)


def parse_ots(data: bytes, head: str):
    """(header_error, tree_error, proof) for a .ots file that should stamp
    sha256(bytes(head)). proof = {bitcoin: [(height, merkle_root)], pending:
    [calendar uri], unknown: [tag hex], unverifiable: [height]}."""
    if len(data) > OTS_MAX_FILE:
        return "proof file too large", None, None
    if not data.startswith(OTS_MAGIC):
        return "not an OpenTimestamps proof", None, None
    r = _Reader(data)
    r.pos = len(OTS_MAGIC)
    try:
        if r.varuint() != 1 or r.byte() != 0x08:
            return "not a SHA256 OpenTimestamps proof (major version 1)", None, None
        digest = r.bytes(32)
    except OtsError:
        return "not a SHA256 OpenTimestamps proof", None, None
    if digest != hashlib.sha256(hx(head)).digest():
        return "stamps a different digest than sha256(chain_head)", None, None
    proof = {"bitcoin": [], "pending": [], "unknown": [], "unverifiable": []}
    try:
        _ots_timestamp(r, digest, 0, proof)
        if r.pos != len(data):
            raise OtsError("trailing bytes after the proof tree")
    except OtsError as e:
        return None, str(e), None
    return None, None, proof


# ---------------------------------------------------------------- Bitcoin
# An honest stamp reaches Bitcoin within hours (calendars commit every few
# blocks). A proof attested much later than its anchor was created is what a
# rewritten checkpoint history with freshly stamped .ots files looks like.

MAX_STAMP_DELAY_S = 48 * 3600   # latest acceptable block time after created_at
MAX_CLOCK_SKEW_S = 7200         # a block time may run 2 h ahead of real time
# An honest anchor is Bitcoin-attested within hours and the checkpoint repo
# upgrades its proof daily. With --btc-api, an anchor older than this without a
# verified Bitcoin attestation is an error, not a note: a history forged later
# cannot show an early attestation, so "no attestation" is what it would show.
MUST_BE_ATTESTED_AFTER_S = 72 * 3600


def overdue(created_at) -> bool:
    return created_at is not None and time.time() - int(created_at) > MUST_BE_ATTESTED_AFTER_S


def http_get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "mpt-receipt-verify"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read(4096).decode("ascii").strip()


def block_header(api: str, height: int) -> bytes:
    """80-byte header of block `height` from an Esplora API, checked against
    the block hash the same API reports."""
    api = api.rstrip("/")
    block_hash = http_get_text(f"{api}/block-height/{height}").lower()
    header = bytes.fromhex(http_get_text(f"{api}/block/{block_hash}/header"))
    if len(header) != 80:
        raise ValueError(f"header of block {height} is {len(header)} bytes, not 80")
    if hashlib.sha256(hashlib.sha256(header).digest()).digest()[::-1].hex() != block_hash:
        raise ValueError(f"header of block {height} does not hash to {block_hash}")
    return header


def utc(t: int) -> str:
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def check_bitcoin_time(where: str, seq: int, data: bytes, head: str, created_at, apis, headers: dict,
                       errors: list, notes: list):
    """Parse a .ots proof of anchor #seq and, with Bitcoin APIs, check that
    Bitcoin attested it no later than MAX_STAMP_DELAY_S after created_at."""
    header_err, tree_err, proof = parse_ots(data, head)
    if header_err:
        errors.append(f"{where}: {header_err}")
        return

    def unattested(reason: str) -> None:
        if apis and overdue(created_at):
            errors.append(f"{where}: anchor #{seq} is older than {MUST_BE_ATTESTED_AFTER_S // 3600} h "
                          f"and {reason}: an honest anchor is attested within hours")
        else:
            notes.append(f"{where}: {reason}")

    if tree_err:
        unattested(f".ots proof tree unreadable ({tree_err}): no Bitcoin time checked")
        return
    for tag in proof["unknown"]:
        notes.append(f"{where}: .ots carries an unknown attestation {tag} (skipped)")
    for h in proof["unverifiable"]:
        notes.append(f"{where}: Bitcoin block {h} branch needs ripemd160, missing in this Python: not checked")
    if not proof["bitcoin"]:
        if not proof["unverifiable"]:
            unattested(".ots still pending (no Bitcoin attestation yet)")
        return
    if not apis:
        h = min(height for height, _ in proof["bitcoin"])
        notes.append(f"{where}: Bitcoin block {h}: run with --btc-api to check its time")
        return

    verified = []
    for height, root in sorted(set(proof["bitcoin"])):
        if height not in headers:
            got = set()
            for api in apis:
                try:
                    got.add(block_header(api, height))
                except Exception as e:  # noqa: BLE001 — report, do not crash
                    errors.append(f"{where}: Bitcoin API {api} failed for block {height}: {e}")
            if len(got) > 1:
                errors.append(f"{where}: Bitcoin APIs disagree on block {height}")
            headers[height] = got.pop() if len(got) == 1 else None
        header = headers[height]
        if header is None:
            continue
        if header[36:68] != root:
            errors.append(f"{where}: Bitcoin block {height} does not commit to this proof (merkle root differs)")
            continue
        verified.append((int.from_bytes(header[68:72], "little"), height))
    if not verified:
        unattested("no Bitcoin attestation could be verified")
        return

    t, height = min(verified)
    if created_at is None:
        notes.append(f"{where}: Bitcoin block {height} at {utc(t)}; anchor has no creation time to compare")
        return
    delay = t - int(created_at)
    if delay > MAX_STAMP_DELAY_S:
        errors.append(f"{where}: Bitcoin attests anchor #{seq} only at {utc(t)}, "
                      f"{delay / 3600:.0f} h after it was created: rewritten history?")
    elif delay < -MAX_CLOCK_SKEW_S:
        errors.append(f"{where}: Bitcoin attests anchor #{seq} at {utc(t)}, "
                      f"{-delay / 3600:.0f} h BEFORE it was created: impossible for an honest stamp")
    else:
        notes.append(f"{where}: Bitcoin block {height} at {utc(t)} ({delay / 3600:+.1f} h after anchoring)")


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
    ap.add_argument("--btc-api", action="append", default=[],
                    help="Esplora Bitcoin API, e.g. https://mempool.space/api (repeat for independent sources)")
    args = ap.parse_args()
    if not args.receipt and not args.checkpoints:
        ap.print_usage()
        return 2

    errors, notes = [], []
    receipt_anchors = {}
    headers = {}  # Bitcoin height -> verified 80-byte header (None = unavailable)
    if len(args.btc_api) == 1:
        notes.append("only one --btc-api given: a single Bitcoin API is trusted for block headers")

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
            if a.get("ots") and int(a["seq"]) not in receipt_anchors:
                # an embedded proof makes the receipt verifiable without the checkpoint repo
                try:
                    ots = hx(a["ots"])
                except ValueError:
                    errors.append(f"{where}: anchor #{a['seq']} embedded ots is not hex")
                else:
                    check_bitcoin_time(f"{where}: anchor #{a['seq']}", int(a["seq"]), ots, a["chain_head"],
                                       a.get("anchored_at"), args.btc_api, headers, errors, notes)
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
                check_bitcoin_time(f"checkpoint #{seq}", seq, open(ots, "rb").read(), a["chain_head"],
                                   a.get("created_at"), args.btc_api, headers, errors, notes)
            elif args.btc_api and overdue(a.get("created_at")):
                errors.append(f"checkpoint #{seq}: no .ots file for an anchor older than "
                              f"{MUST_BE_ATTESTED_AFTER_S // 3600} h")
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
