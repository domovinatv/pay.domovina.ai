# ADR 0003 — Phase 5: PhoneSBT contract design (supersedes ADR 0002 uniqueness mechanism)

**Status:** Accepted, awaiting implementation.
**Date:** 2026-05-22
**Decision owners:** Matija Stepanic, ITalk d.o.o.

## Context

We need a sybil-resistant phone-uniqueness signal for `wallet.domovina.ai`
that is queryable by any third-party dApp on Gnosis Chain without
relying on our cooperation, our API, or our continued existence. The
underlying intuition is unchanged from ADR 0002: a wallet that has
re-verified the same phone over years is a much stronger humanity
signal than a wallet that minted yesterday from a freshly-bought
prepaid SIM. What changes here is the mechanism through which that
signal is enforced.

ADR 0002 proposed a `PhoneAttestation` contract whose uniqueness
property — "one phone, one wallet" — was a *soft* signal: each wallet
appended its own per-phone hash to a per-wallet log, and external
indexers were expected to spot collisions across logs to flag sybils.
That is observable but not enforced. Two wallets can hold a colliding
attestation simultaneously; nothing on chain ever removes the older
one or tells a consumer which holder is currently "the" wallet for
that phone. After implementing the parallel offchain combinatorics
fix (the many-to-many `wallet_phone_bindings` table introduced in
Phase 4a-fix migration `0010_wallet_phone_bindings.sql`) it became
clear that the offchain history is naturally many-to-many while the
*current ownership* state deserves a hard, single-slot primitive that
external dApps can read with a single contract call.

ADR 0003 supersedes the uniqueness mechanism of ADR 0002 with a
Soulbound Token design: at any moment, **exactly one wallet holds the
SBT for a given phone**. The previous holder loses the slot atomically
when a fresh OTP confirms ownership at a new wallet. The combination
of (a) the offchain many-to-many history table and (b) the onchain
single-active-holder primitive gives consumers both the full history
and the current authoritative state. The rest of ADR 0002 — the
self-custody posture inherited from ADR 0001, the gas-relay-only
backend role, the public-readability requirement — is unchanged.

## Research summary

Before committing to "write our own ~150 LOC contract," we surveyed
existing audited candidates: Ethereum Attestation Service, Holonym,
EIP-5484 reference implementations, Worldcoin proof-of-personhood,
Gitcoin Passport, Coinbase Verifications, Civic, Quadrata, Galxe,
BrightID, Proof of Humanity, GoodDollar, and Sismo. Each was rejected
on at least one of three axes: wrong chain (Worldcoin / Coinbase
Verifications / most Holonym deployments are not on Gnosis), wrong
trust shape (Gitcoin Passport, Galxe, and Civic embed vendor SaaS in
the trust path), or wrong primitive (EAS gives us schemas and a
resolver hook but not a soulbound single-slot semantic — building our
behavior on top of EAS turns out to be nearly the same code volume as
writing it cleanly, plus we'd have to self-deploy EAS on Gnosis since
the official deployment is not present there).

The verdict, committed by this ADR, is to write a minimal contract of
roughly 150 lines built on the EIP-5484 (Consensual Soulbound Token)
reference skeleton, OpenZeppelin's `EIP712` and `ECDSA` for verifier
signature checks, and `Ownable` for governance. EAS plus a custom
resolver remained the closest near-miss; we picked the single-contract
path for operational simplicity and because the resolver path would
have left a second EAS contract on chain whose upgrade story is not
ours to control.

## Decision

We will deploy a single contract, `PhoneSBT.sol`, on Gnosis Chain
(chain ID 100). The contract enforces "one phone = one active SBT
holder" and exposes the full migration history through standard ERC-721
`Transfer` events.

### Hard rules

1. **One global deployment.** No per-user deploys, no per-app
   instances. The same contract address serves every consumer.
2. **`tokenId = uint256(phoneHash)`**, where
   `phoneHash = HMAC-SHA256(PHONE_PEPPER, e164_phone)`. The same phone
   maps to the same slot forever. Pepper rotation is explicitly out of
   scope for v1; see the pepper-rotation resolution below.
3. **Soulbound.** No `transferFrom`, no `approve`, no
   `safeTransferFrom`. The only path that moves the token is `claim()`,
   which requires a verifier-signed EIP-712 authorization produced by
   our OTP backend after a successful OTP confirmation.
4. **Atomic ownership migration.** If `claim()` is called for a
   `phoneHash` whose slot is currently held by some wallet A, the call
   atomically zeroes A's holding and assigns the slot to `msg.sender`.
   Single transaction, single state change, single `Transfer(A, B,
   tokenId)` event.
5. **`firstClaimedAt` preserved across migrations.** The contract
   records the timestamp at which *any* wallet first claimed this
   `phoneHash`. Subsequent migrations bump `lastReverifiedAt` and
   `transferCount` but leave `firstClaimedAt` untouched. This is the
   long-term age signal that motivated the whole feature.
6. **`lastReverifiedAt` always bumps.** Every successful `claim()` —
   including a self-reclaim by the same holder — refreshes
   `lastReverifiedAt`. Third-party dApps gate on freshness here (e.g.
   "must be re-verified within the last 365 days") to distinguish live
   wallets from abandoned ones.
7. **Verifier address is mutable but Safe-owned.** The contract
   exposes `setVerifier(address)` callable only by `owner()`, where
   `owner()` is a 2-of-3 Gnosis Safe controlled by Matija plus two
   designated co-signers. Verifier rotation requires multisig
   approval; a hot CF Worker key cannot rotate the verifier on its
   own.
8. **No revoke, no admin burn.** The contract has no `adminBurn`, no
   `revoke`, no kill switch. The only way a wallet loses its SBT is
   for some other wallet to claim the same `phoneHash` with a fresh
   OTP, or for the current holder to voluntarily call `release()` (see
   resolution 2 below).

### Solidity sketch

```solidity
// PhoneSBT.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract PhoneSBT is Ownable, EIP712 {
    using ECDSA for bytes32;

    struct Slot {
        address holder;
        uint64  firstClaimedAt;
        uint64  lastReverifiedAt;
        uint32  transferCount;
    }

    address public verifier;
    mapping(uint256 => Slot) private slots;          // tokenId → slot
    mapping(address => uint256[]) private heldBy;    // wallet → tokenIds
    mapping(uint256 => uint256) private heldByIndex; // tokenId → index in heldBy[holder]+1
    mapping(bytes32 => bool) public usedNonces;

    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(address wallet,uint256 tokenId,bytes32 nonce,uint256 deadline)"
    );

    event Claimed(uint256 indexed tokenId, address indexed from, address indexed to, uint32 transferCount);
    event Released(uint256 indexed tokenId, address indexed by);
    event VerifierRotated(address indexed previousVerifier, address indexed newVerifier);

    constructor(address initialOwner, address initialVerifier)
        Ownable(initialOwner)
        EIP712("DomovinaPhoneSBT", "1")
    {
        verifier = initialVerifier;
        emit VerifierRotated(address(0), initialVerifier);
    }

    function claim(uint256 tokenId, bytes32 nonce, uint256 deadline, bytes calldata sig) external {
        require(block.timestamp <= deadline, "expired");
        require(!usedNonces[nonce], "nonce_used");
        usedNonces[nonce] = true;

        bytes32 structHash = keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, tokenId, nonce, deadline));
        address signer = _hashTypedDataV4(structHash).recover(sig);
        require(signer == verifier && signer != address(0), "bad_sig");

        Slot storage s = slots[tokenId];
        address previous = s.holder;
        if (previous == msg.sender) {
            s.lastReverifiedAt = uint64(block.timestamp);
            emit Claimed(tokenId, previous, msg.sender, s.transferCount);
            return;
        }
        if (previous != address(0)) {
            _removeFromHeldBy(previous, tokenId);
            s.transferCount += 1;
        } else {
            s.firstClaimedAt = uint64(block.timestamp);
        }
        s.holder = msg.sender;
        s.lastReverifiedAt = uint64(block.timestamp);
        _appendToHeldBy(msg.sender, tokenId);
        emit Claimed(tokenId, previous, msg.sender, s.transferCount);
    }

    function release(uint256 tokenId) external {
        Slot storage s = slots[tokenId];
        require(s.holder == msg.sender, "not_holder");
        _removeFromHeldBy(msg.sender, tokenId);
        delete slots[tokenId];
        emit Released(tokenId, msg.sender);
    }

    function setVerifier(address newVerifier) external onlyOwner {
        require(newVerifier != address(0), "zero_verifier");
        emit VerifierRotated(verifier, newVerifier);
        verifier = newVerifier;
    }

    function slotOf(uint256 tokenId) external view returns (Slot memory) { return slots[tokenId]; }
    function tokensOf(address wallet) external view returns (uint256[] memory) { return heldBy[wallet]; }

    // ... _appendToHeldBy / _removeFromHeldBy: O(1) swap-and-pop via heldByIndex.
}
```

The full reference implementation (with the index-bookkeeping helpers,
NatSpec, custom errors, and the EIP-5484 `BurnAuth.Both` declaration
expected by tooling) lands in Phase 5a. The sketch above is normative
for the externally observable behavior.

## Trust model and blast radius

The verifier key is the only piece of our infrastructure that has any
authority over the SBT registry. We are explicit about what it can and
cannot do.

What the verifier key **can** do if stolen:

- Authorize a `claim()` call for any `phoneHash` by any wallet,
  effectively assigning the SBT for that phone to an attacker-controlled
  wallet. The legitimate holder loses the slot.
- Do this for every phone in the system in a single sweep. Total
  compromise of the sybil-resistance signal until a v2 contract is
  deployed and consumers migrate their queries.

What the verifier key **cannot** do, even with full compromise:

- Touch any user Safe. The SBT contract has no module relationship
  with user Safes and cannot author transactions on their behalf.
- Move any user funds. There is no path from `PhoneSBT` to a user's
  EURe balance, xDAI balance, or any other asset.
- Modify Safe owners, threshold, or fallback handlers.
- Prevent a current holder from continuing to use their wallet for any
  other purpose. Loss of SBT slot is a reputation event, not a custody
  event.
- Re-mint or duplicate `tokenId`s. The slot mapping is keyed by
  `phoneHash` and each phone has exactly one slot for the lifetime of
  the contract.

Mitigations:

- The verifier private key lives only in CF Worker Secrets. It is
  never copied to development machines, never committed, never
  forwarded over email or chat. Rotation procedure is in the
  `backend/README.md` runbook.
- The contract's `owner()` is a 2-of-3 Safe (Matija plus two
  co-signers, identities recorded in the internal ops runbook). Even
  with full CF Worker breach, the attacker cannot rotate the verifier
  to one they control without compromising two additional signers.
- Compromise-recovery procedure: deploy a v2 `PhoneSBT` with a fresh
  verifier key; existing SBTs in v1 remain a permanent historical
  record (which is useful — the v1 transfer log still shows the
  attacker's sweep); new claims happen on v2; third-party consumers
  update the contract address they query. The migration is a
  configuration change for consumers, not a data migration.

## Resolutions for the five open questions from prior research

1. **Verifier key custody and rotation.** Resolved above: CF Worker
   Secrets for the hot key, 2-of-3 Safe for the contract owner, Safe
   multisig required to rotate the verifier. No solo-rotation path
   exists.
2. **Burn / release semantics.** Yes, the contract exposes
   `release()`, callable only by the current holder. It zeroes the
   slot entirely — `holder`, `firstClaimedAt`, `lastReverifiedAt`, and
   `transferCount` are all reset. The next claimant of that
   `phoneHash` starts fresh and does **not** inherit the prior
   reputation. This handles the "I'm selling my SIM, the next owner
   shouldn't inherit my reputation footprint" case cleanly.
3. **`PHONE_PEPPER` rotation.** Never rotated within the v1 contract.
   The pepper is baked into the EIP-712 domain separator at deploy
   time. If we ever need to rotate (catastrophic pepper leak), we
   deploy a v2 contract with a new domain; users re-claim on v2 from
   scratch and v1 becomes a frozen historical record. The user-facing
   privacy notice at bind time must mention this explicitly so users
   understand a future pepper rotation will not migrate their
   reputation.
4. **Freshness signal.** Yes, `lastReverifiedAt` is a first-class
   field. Third parties consume the full tuple `(holder,
   firstClaimedAt, lastReverifiedAt, transferCount)` and weight trust
   on the combination. A high `firstClaimedAt` age paired with a
   recent `lastReverifiedAt` and a low `transferCount` is the maximum
   signal; the inverse is the sybil-suspicion shape.
5. **Audit budget.** Defer formal audit until at least one external
   dApp commits to consuming the contract for a non-trivial purpose.
   The initial deploy is for internal use by `wallet.domovina.ai`
   itself and a public viewer at `wallet.domovina.ai/reputation/...`,
   both of which we control end-to-end. The third-party README must
   carry a "pre-audit, use at your own risk" notice until that
   changes. Estimated audit cost when the time comes: ~$8-15k for a
   Pashov Audit Group or Cantina contest pass on a contract of this
   size.

## Combinatorics handling

This section pairs the onchain SBT state machine with the offchain
many-to-many history table introduced in Phase 4a-fix.

1. **One wallet, N phones.** The wallet holds N SBTs, one per
   `phoneHash`. `tokensOf(wallet)` returns the full list; third-party
   dApps enumerate it to compute "how many distinct phones has this
   wallet attested to." The offchain `wallet_phone_bindings` table
   mirrors this with per-phone timestamps and re-verification counts
   for richer UI displays.
2. **One phone, N wallets (sybil shape).** At most one wallet holds
   the SBT slot at any moment, but the full `Transfer` / `Claimed`
   event log records every wallet that has ever held it. Third-party
   indexers compute `distinct_holders(tokenId)` from the log as a
   sybil-suspicion signal. Combined with the offchain bindings table
   (which we publish a public read endpoint for) consumers have both
   the live state and the full history without needing our
   cooperation for the onchain half.
3. **Wallet A migrates to wallet B (legitimate user change).** The
   user re-verifies their original phone on B; the resulting OTP
   produces a verifier-signed EIP-712 authorization for B; B calls
   `claim()` which atomically transfers the SBT from A to B in one
   transaction. `firstClaimedAt` is preserved, `transferCount` is
   incremented by one, `lastReverifiedAt` is bumped. From a consumer's
   point of view the reputation footprint moves cleanly to B with
   exactly one transfer recorded.
4. **Bot farm with one shared phone.** Each fresh wallet that
   completes OTP against the shared phone zeroes the previous bot's
   SBT. `transferCount` climbs rapidly, which is itself the onchain
   sybil flag — any consumer can refuse to honor a slot whose
   `transferCount` exceeds a threshold within a window.
5. **Bot farm with N distinct phones.** Each bot gets its own SBT
   slot. The phone-uniqueness primitive cannot detect this case; the
   only signal is that all `firstClaimedAt` values are recent and
   clustered in time. Detecting this shape requires layering time-
   based reputation accrual (the original ADR 0002 intuition: the
   *age* of the relationship is the signal) and/or correlation with
   other reputation systems. We do not pretend `PhoneSBT` solves this
   alone.

## Phase 5 implementation breakdown

Refines the Phase 5a-5e structure from ADR 0002 to match the SBT
design.

- **5a — Solidity plus tests (~1 session).** Write `PhoneSBT.sol`,
  `IPhoneSBT.sol` interface, and a Hardhat test suite covering: fresh
  claim, self-reclaim (bumps `lastReverifiedAt` only), migration A → B
  (preserves `firstClaimedAt`, increments `transferCount`),
  `release()` and subsequent re-claim from zero, verifier rotation
  through the Safe, EIP-712 signature replay rejection via
  `usedNonces`, deadline expiry, multi-phone enumeration via
  `tokensOf`, swap-and-pop correctness in `heldBy` bookkeeping.
- **5b — Deploy and Gnosisscan verification (~30 min).** Deploy
  through the 2-of-3 Safe with the initial verifier set to a CF
  Worker key (generated for this purpose, never shared). Verify
  source on Gnosisscan. Write the contract address into
  `wallet/src/lib/constants.ts` and `backend/wrangler.toml`.
- **5c — Backend verifier signing (~1 session).** Extend
  `/api/wallets/:credentialId/bind-phone` so that after a successful
  OTP confirmation it computes `phoneHash`, derives `tokenId`,
  generates a 32-byte random `nonce` and a `deadline` (15 minutes
  from issuance), signs the EIP-712 `Claim` struct with
  `VERIFIER_PRIVATE_KEY`, and returns the signature plus inputs to
  the PWA. Add the secret to `wrangler.toml`. Document the rotation
  procedure: generate new key locally, set it via
  `wrangler pages secret put VERIFIER_PRIVATE_KEY`, then execute
  `setVerifier(newAddress)` through the owner Safe.
- **5d — PWA claim flow (~1 session).** The `BindPhone` screen
  receives the EIP-712 signature bundle, builds
  `phoneSBT.claim(tokenId, nonce, deadline, sig)` calldata, wraps it
  in a `safe.execTransaction` payload, asks the passkey to sign, and
  submits via the existing relayer. The Wallet screen renders the
  per-phone SBT status (firstClaimedAt, lastReverifiedAt,
  transferCount) with a link to the claim transaction on Gnosisscan.
- **5e — Public viewer plus third-party docs (~half session).** The
  route `wallet.domovina.ai/reputation/:address` is unauthenticated
  and shows the attestation history for any Safe address: held
  tokens, per-token timestamps, transfer counts. Document the
  contract address, ABI snippet, and a JS read example in the
  `wallet/README.md` "Third-party integration" section. Include the
  pre-audit disclaimer.

## Prerequisites from the current session

The offchain Phase 4a-fix work must land before Phase 5 implementation
begins. The SBT design assumes the offchain history is already
many-to-many, because both representations need to be coherent for
the public viewer to render correctly.

- Migration `0010_wallet_phone_bindings.sql` creates the many-to-many
  table keyed by `(credential_id, phone_hash)` with `first_bound_at`,
  `latest_verified_at`, and `verify_count` columns.
- `bind-phone` is refactored to upsert into the bindings table on
  every successful OTP, not just the first one.
- `GET /api/wallets/:credentialId` returns a `phones[]` array,
  ordered by `latest_verified_at` descending.
- The Wallet screen UI renders per-phone history (count, first bound
  date, latest verified date) instead of a single `has_phone`
  boolean.
- The admin sybil dashboard exposes `distinct wallets per phone hash`
  and `distinct phones per wallet` views for ops review.

Phase 5a should not start until all five items above are merged.

## Privacy disclosures the UI must surface

These exact statements (or close translations into Croatian) must
appear at the moment of first phone bind and at every re-verify.

- "Each verification writes an immutable onchain record at the
  current timestamp. The record cannot be deleted by anyone,
  including us."
- "The phone number itself is never written onchain — only a one-way
  HMAC hash."
- "Anyone querying Gnosis Chain can see how many times your wallet
  has verified phones and approximately when."
- "If you share your phone with someone who later claims your SBT
  slot, you will lose your reputation footprint for that phone
  permanently. This is intentional."

The bind flow must require an explicit acknowledgement checkbox on
the first bind before the OTP request is initiated. Subsequent
re-binds may collapse the disclosure to a single line plus a "details"
expander, but the substance must remain visible.

## What this ADR explicitly does NOT do

Restated from ADR 0001 to make the boundary crisp:

- Does **not** give our backend any onchain authority over user
  Safes. The SBT contract has no module relationship with user Safes.
- Does **not** enable us to move user funds. There is no
  `PhoneSBT → Safe` execution path.
- Does **not** enable us to modify user Safe owners or thresholds.
  Safe ownership remains under the user's passkey, exclusively.
- Does **not** relax the strict self-custody posture established in
  ADR 0001. The verifier key is for sybil-resistance only.
- The verifier key compromise blast radius is bounded to the
  sybil-resistance signal. Compromise costs reputation integrity; it
  does not cost users any custody.

## Amendment 2026-05-22 — verifier custody under reconsideration

After this ADR was accepted Matija raised the option of running the
verifier as a small signing service on a **physical machine in his
office** (Raspberry Pi-class), with the CF Worker calling out to it
over a Cloudflare Tunnel to sign each claim authorization. The
private key would never live in any cloud service.

This is a refinement of section "5c (Backend verifier signing)" only;
the contract design, claim flow, combinatorics handling, and all
self-custody hard rules in this ADR are unaffected.

The choice between the two custody paths is to be made at the moment
Phase 5c implementation begins, not now. The relevant memory entry is
`[[project-phase5-hardware-verifier-intention]]`, which lists six
sub-questions that must be resolved before code lands. If the
hardware path is taken, an ADR 0004 codifying it is to be written
before any implementation; if the CF Worker path is taken anyway,
the reasoning must be documented as an amendment here.

Do not skip this re-evaluation at Phase 5c kickoff.

## References

- ADR 0001 — `docs/decisions/0001-no-server-side-recovery.md`
  (foundational self-custody rules, hard-binding for this ADR).
- ADR 0002 — `docs/decisions/0002-phase-5-onchain-phone-attestation.md`
  (predecessor; this ADR supersedes its uniqueness mechanism but
  preserves its self-custody and gas-relay-only posture).
- Memory entries: `[[reference-wallet-domovina]]`,
  `[[reference-otp-domovina]]`, `[[project-self-custody-principle]]`,
  `[[project-phase5-onchain-attestation]]`.
- EIP-5484 — Consensual Soulbound Token reference.
- OpenZeppelin Contracts — `utils/cryptography/EIP712.sol`,
  `utils/cryptography/ECDSA.sol`, `access/Ownable.sol`.
- Ethereum Attestation Service — `https://github.com/ethereum-attestation-service/eas-contracts`
  (considered and rejected as a base layer; see Research summary).
