#!/usr/bin/env python3
"""Mirror MPT receipt anchors into this public repo (ADR 0023 §3).

Standard library only; no secrets. Run daily by .github/workflows/checkpoint.yml:

  1. fetch every anchor newer than the last one here (GET /api/receipts/anchors?after=N)
  2. write anchors/<seq>.json (sorted keys) and anchors/<seq>.ots
  3. (the workflow then runs `ots upgrade` on pending proofs)
  4. verify the whole chain with mpt_receipt_verify.py --checkpoints anchors/
  5. rewrite index.json

A broken chain makes the workflow fail: that failure is the public alarm.
"""

import json
import os
import sys
import urllib.request

API = os.environ.get("MPT_API", "https://mpt.domovina.ai/api/receipts")
HERE = os.path.dirname(os.path.abspath(__file__))
ANCHORS = os.path.join(HERE, "anchors")
UA = {"User-Agent": "mpt-receipts-checkpoints"}


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read()


def local_seqs():
    return sorted(int(n[:-5]) for n in os.listdir(ANCHORS) if n.endswith(".json") and n[:-5].isdigit())


def fetch_new() -> int:
    os.makedirs(ANCHORS, exist_ok=True)
    have = local_seqs()
    after = have[-1] if have else 0
    added = 0
    while True:
        page = json.loads(get(f"{API}/anchors?after={after}"))["anchors"]
        if not page:
            return added
        for a in page:
            seq = int(a["seq"])
            with open(os.path.join(ANCHORS, f"{seq}.json"), "w", encoding="utf-8") as f:
                json.dump(a, f, sort_keys=True, indent=2)
                f.write("\n")
            if a.get("ots_available"):
                with open(os.path.join(ANCHORS, f"{seq}.ots"), "wb") as f:
                    f.write(get(f"{API}/anchors/{seq}.ots"))
            after = seq
            added += 1


BITCOIN_TAG = bytes.fromhex("0588960d73d71901")


def write_index():
    rows = []
    for seq in local_seqs():
        a = json.load(open(os.path.join(ANCHORS, f"{seq}.json"), encoding="utf-8"))
        ots = os.path.join(ANCHORS, f"{seq}.ots")
        btc = os.path.exists(ots) and BITCOIN_TAG in open(ots, "rb").read()
        rows.append({
            "seq": seq,
            "chain_head": a["chain_head"],
            "leaf_count": a["leaf_count"],
            "total_leaves": a["total_leaves"],
            "created_at": a["created_at"],
            "ots": os.path.exists(ots),
            "bitcoin": btc,
        })
    with open(os.path.join(HERE, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"schema": "mpt-receipt-checkpoints/1", "anchors": rows}, f, sort_keys=True, indent=2)
        f.write("\n")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "fetch"
    if cmd == "fetch":
        print(f"new anchors: {fetch_new()}")
    elif cmd == "index":
        write_index()
    else:
        sys.exit(f"unknown command {cmd}")
