# ADR 0002 — Phase 5: Onchain phone attestation contract

**Status:** Accepted as planned future work. **Not yet implemented.**
**Date:** 2026-05-22
**Decision owners:** Matija Stepanic, ITalk d.o.o.

## Context

ADR 0001 establishes that `wallet.domovina.ai` is 100% self-custody and
that the server holds no key with authority over user Safes. That
ADR also kept the optional phone-binding feature (via
[`reference-otp-domovina`](../../../.claude/projects/-Users-ms-git-domovinatv-pay-domovina-ai/memory/reference_otp_domovina.md))
for sybil resistance, SMS notifications, and customer support — not
for recovery.

A clearer purpose for the phone-binding feature has emerged: build a
**long-term, public, immutable reputation footprint** for each wallet.

The intuition (Matija, 2026-05-22):

> "Three years from now, when someone uses the same wallet in another
> dApp, they should be able to see that this wallet has done 17 phone
> verifications over time, which makes the ownership-of-the-phone
> signal very strongly valued — versus a wallet whose phone was
> verified yesterday from a freshly-purchased prepaid SIM."

The longer a wallet has periodically re-verified the same phone, the
stronger the trust signal. The verification *frequency* and *age* are
what matter, not the binding itself.

## Decision

We will build a `PhoneAttestation` contract on Gnosis Chain that lets
any wallet record a phone-verification footprint **signed by the
wallet's own key (the user's passkey)**. The contract is stateless
beyond per-wallet timestamps. Our backend has no special role beyond
gas relay.

## Hard rules (binding, inheriting from ADR 0001)

1. **Only the wallet itself can write its own attestations.** The
   contract uses `msg.sender` as the wallet identifier. No admin, no
   role, no backdoor.
2. **Our server's only role is gas relay.** Same CF Worker relay as
   for ordinary Send transactions — submits the user-signed
   `safe.execTransaction` that internally calls `attestation.attest(...)`.
3. **No on-chain authority over Safe ownership or funds.** This
   contract cannot touch the Safe in any way; it only records data
   in its own storage keyed by `msg.sender`.
4. **Read access is fully public.** Any dApp, any chain explorer, any
   third party can query the attestation history for any wallet
   without our cooperation.

## Contract design

```solidity
// PhoneAttestation.sol — deploys once globally, not per-user.
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PhoneAttestation {
    struct Record {
        uint64 timestamp;
        bytes32 verificationHash;
    }

    // Per-wallet append-only log. Never deleted, never modified.
    mapping(address => Record[]) private records;

    event PhoneAttested(
        address indexed wallet,
        uint256 indexed sequence,
        bytes32 verificationHash,
        uint64 timestamp
    );

    function attest(bytes32 verificationHash) external {
        records[msg.sender].push(Record(uint64(block.timestamp), verificationHash));
        emit PhoneAttested(
            msg.sender,
            records[msg.sender].length - 1,
            verificationHash,
            uint64(block.timestamp)
        );
    }

    function count(address wallet) external view returns (uint256) {
        return records[wallet].length;
    }

    function first(address wallet) external view returns (Record memory) {
        require(records[wallet].length > 0, "no attestations");
        return records[wallet][0];
    }

    function latest(address wallet) external view returns (Record memory) {
        uint256 len = records[wallet].length;
        require(len > 0, "no attestations");
        return records[wallet][len - 1];
    }

    function at(address wallet, uint256 i) external view returns (Record memory) {
        return records[wallet][i];
    }

    function range(address wallet, uint256 fromIdx, uint256 toIdx)
        external
        view
        returns (Record[] memory)
    {
        uint256 len = records[wallet].length;
        require(toIdx <= len, "out of range");
        require(fromIdx <= toIdx, "bad range");
        Record[] memory out = new Record[](toIdx - fromIdx);
        for (uint256 i = fromIdx; i < toIdx; i++) {
            out[i - fromIdx] = records[wallet][i];
        }
        return out;
    }
}
```

Properties:

- **Stateless beyond user-controlled writes.** No owner, no admin role,
  no upgrade path. Deploy once and forget. Truly immutable.
- **Per-attestation event** so chain indexers (Subgraph, Dune, etc.)
  can read the full history cheaply.
- **Cheap gas** — ~50-80k per `attest()` on Gnosis, ~$0.0002.

## Verification hash design

What goes into `verificationHash`? Three options were considered (see
session log 2026-05-22 — choose between them at build time):

### Option A — Per-attestation random salt (max privacy)

```ts
const verificationHash = await crypto.subtle.sign(
  'HMAC',
  PHONE_PEPPER_KEY,
  encode(otpVerificationId)
);
```

- Different hash each time, even for the same phone
- No cross-wallet correlation observable onchain
- Server can retro-correlate (it knows the verificationId→phone map via
  the otp.domovina.ai lookup chain from ADR 0001)
- **Weakest sybil signal** — same person attesting from 10 wallets
  looks identical to 10 unrelated people

### Option B — Per-phone hash (strongest sybil signal) — recommended

```ts
const verificationHash = await crypto.subtle.sign(
  'HMAC',
  PHONE_PEPPER_KEY,
  encode(e164Phone)
);
```

- Same hash always for the same phone, across all wallets that share
  it
- Public observers see "these N wallets share a phone hash" → sybil
  flag without needing our cooperation
- Trade-off: leaks the *fact* that N wallets share a phone (not which
  phone, not who)
- **Strongest sybil-detection signal.** Matches the "long-term
  ownership of the phone" intuition that motivated the feature.

### Option C — Hybrid: phone × epoch (sybil signal that rotates)

```ts
const epoch = Math.floor(unixSeconds() / SECONDS_PER_EPOCH);
const verificationHash = HMAC(pepper, e164Phone + ':' + epoch);
```

- Sybil correlation works within an epoch (e.g. 90 days)
- Cross-epoch correlation requires server cooperation
- Easier `PHONE_PEPPER` rotation (old hashes become orphaned per epoch
  rather than for the entire dataset)

**Default choice for Phase 5 implementation: Option B.** Rationale: the
whole point is the sybil-resistance signal. Option A throws that away;
Option C compromises it for a privacy gain that's already weak (the
hash is not reversible without pepper anyway).

If privacy concerns later outweigh sybil-detection value, migrate to C.
Never to A — the resulting attestations would have no public utility.

## Privacy trade-offs to disclose to users at bind time

When user binds (and each re-verification), the UI must say:

- "Each verification writes an immutable record onchain at timestamp
  X. Records are public forever and cannot be deleted. The phone
  number itself is never written — only a one-way hash. Your wallet's
  identity is *publicly bound* to this hash, so anyone querying the
  chain will see N attestations for your wallet over time."
- "The hash is one-way: outsiders cannot derive your phone number from
  it. But if multiple wallets verify the same phone, observers will
  see that those wallets share a phone hash."
- "There is no GDPR right of erasure for onchain data. Binding is
  irreversible."

`PHONE_PEPPER` rotation breaks all past attestations' verification
chains. To avoid this, treat `PHONE_PEPPER` as a permanent, never-rotated
secret. If it ever leaks, all phone hashes become reversible to anyone
holding the leaked pepper + a brute-force list of phones (which is
trivially generated for any national prefix). This is a **catastrophic
privacy event** — store the pepper in CF Secrets only, never check it
in, never copy to dev machines.

## Implementation phases

### Phase 5a: Deploy the contract

- Audit-equivalent review (it's ~30 lines; doesn't need a formal audit
  budget)
- Verify on Gnosisscan
- Add address to `wallet/src/lib/constants.ts` and
  `backend/wrangler.toml`
- Cost: ~$1-5 xDAI for deploy

### Phase 5b: Backend changes

- `bind-phone` endpoint also returns `verificationHash` (computed via
  Option B) so the client can build the `attest()` calldata
- New table `phone_attestations` mirrors onchain state for fast
  queries by admin / public APIs:
  ```sql
  CREATE TABLE phone_attestations (
    credential_id TEXT NOT NULL,
    verification_id TEXT NOT NULL,
    onchain_tx_hash TEXT NOT NULL,
    verification_hash TEXT NOT NULL,
    attested_at INTEGER NOT NULL,
    PRIMARY KEY (credential_id, verification_id)
  );
  ```
- New public admin endpoint `GET /admin/api/wallets/:credentialId/attestations`
- Re-verification endpoint allows a wallet to re-bind the same phone
  any number of times — each consumes a new OTP verification, each
  produces a new attestation. **No "already bound" rejection.**

### Phase 5c: PWA changes

- After successful OTP confirmation in `BindPhone.tsx`:
  1. PWA receives `verificationHash` from backend
  2. PWA builds `attestation.attest(verificationHash)` calldata
  3. Wraps in `safe.execTransaction(...)` and asks passkey to sign
  4. Submits via relay (same path as ordinary Send)
  5. Shows "✓ Attestation #N onchain at [tx link]" with link to
     Gnosisscan
- Wallet screen shows attestation history:
  - "Phone verified N times. First: <date>. Latest: <date>."
  - "+ Verify again" button always present, never disabled
- Public viewer at `wallet.domovina.ai/reputation/0x...` (no auth)
  showing any wallet's attestation history for third-party use

### Phase 5d: Third-party integration story

- Document the contract address + a JS snippet for other dApps to
  query reputation by wallet address
- Mention in our README so people building on DOMOVINA stack can use
  the signal

## What this enables for users 3 years from now

The motivating scenario, restated concretely:

```
2029: Some new dApp wants to gate a feature on "real human" verification.

Old wallet (verified yesterday once from a prepaid SIM):
   - 1 attestation, age 0 days
   - low reputation signal

Domovina wallet (verified periodically over 3 years):
   - 17 attestations, first 1095 days ago, latest 14 days ago
   - sybil-flag check: no other wallet shares any verification hash
   - very high reputation signal

The new dApp queries PhoneAttestation.count(walletAddress) +
PhoneAttestation.first(walletAddress) on Gnosis and uses the result
to weight trust. No call to our servers needed. No permission asked.
```

This is the long-term value proposition that justifies the
phone-binding feature surviving the recovery deprecation.

## References

- ADR 0001 — `docs/decisions/0001-no-server-side-recovery.md`
  (foundational self-custody rules)
- Memory: `[[project-self-custody-principle]]`,
  `[[reference-otp-domovina]]`, `[[reference-wallet-domovina]]`
- Similar prior art: Gitcoin Passport stamps, Proof of Humanity,
  Worldcoin Orb attestations (different mechanism, similar
  "verifiable reputation footprint" concept)
