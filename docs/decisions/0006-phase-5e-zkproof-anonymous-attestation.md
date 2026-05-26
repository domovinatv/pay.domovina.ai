# ADR 0006 — Phase 5e: zkProof anonymous issuance + voting consumption

**Status:** Accepted (design direction), awaiting research-stage prototypes.
**Date:** 2026-05-26
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Amends:** ADR 0003 (SBT contract storage layout — `oib_hash`/`phone_hash` slots become commitments, not plaintext hashes).
**Inherits from:** ADR 0001 (self-custody), ADR 0002 (Phase 5 rationale), ADR 0003 (SBT contract), ADR 0004 (verifier mesh), ADR 0005 (Certilia + eOI rejection).

## Context

ADR 0003–0005 describe an attestation pipeline whose onchain output
is a row `(holder, identifier_hash, source, latest_at)` where
`identifier_hash` is `H(PEPPER || phone_or_oib)`. That hash is
**deterministic** under a known pepper, and the SBT row itself —
together with the chain's natural pseudonymity collapse for actively-
used wallets — leaks the binding *"this Safe address is a real
Croatian citizen"* to anyone observing the chain.

For Croatia's voter population (~3.7M eligible citizens, ~5M total
OIBs), the dictionary attack on `oib_hash` is trivial once the pepper
is known — and the pepper must be loaded into every mesh node to
hash incoming `id_token` claims. Even keeping the pepper secret in
practice, the SBT's *existence* on a known address is a binding
signal: "this wallet's owner is a Croatian citizen of voting age",
which is itself the GDPR-protected fact the user came to us to
hide. The phone-OTP path has the same shape with a smaller dictionary
(~5M HR phone numbers).

For the project's onchain-voting target use case, this is not
acceptable. A correctly-designed sybil-resistant voting system must:

1. **At issuance time:** prove the user is a real Croatian citizen
   (Certilia signed an `id_token` for a valid OIB) WITHOUT revealing
   the OIB onchain or in any persistent storage outside the mesh.
2. **At consumption time:** prove the voter holds a valid citizenship
   credential WITHOUT linking that proof to the SBT issuance
   transaction, and WITHOUT revealing the OIB or the underlying SBT.
3. **Across both:** prevent double-voting by binding a per-vote
   nullifier to the credential.

This is the canonical zk-SNARK identity-credential pattern. Mature
implementations exist (Semaphore, MACI, Sismo, Polygon ID, BBS+),
each with different trade-offs. This ADR records the architectural
shift and the principles that will guide concrete primitive
selection in a future ADR 0007 once research-stage prototypes are
benchmarked.

## Decision

### Decision 1 — Move from "visible hash" to "Merkle-leaf commitment"

The on-chain SBT row's identifier slot stops being a deterministic
hash of the underlying identifier. Instead it becomes a
**Pedersen-style commitment** `C = Commit(identifier, secret)` where
`secret` is generated client-side at credential receipt and never
leaves the user's device. The leaf is added to a global Merkle tree
(per-source: one tree for `phone_otp_v1`, one for `certilia_v1`,
etc.); only the root is updated onchain at issuance time.

Net effect: the chain sees a new Merkle root after each batch of
issuances, but no specific row reveals "this address has source X
with identifier Y". The mapping from user → leaf is held only by
the user (via the secret) and the verifier mesh's audit log (which
can be aggressively retention-bounded).

The SBT contract from ADR 0003 needs schema amendment:
- Storage: `mapping(source => MerkleTreeRoot) currentRoot;`
- Issuance event: `MerkleRootUpdated(source, oldRoot, newRoot, batchSize)`
  — no per-leaf identifier is emitted.
- Per-holder state: `mapping(holder => mapping(source => uint256))
  lastUpdateBlock;` — used so dApps can require "freshness" without
  needing to know which leaf is yours.

This is **NOT a clean replacement** of ADR 0003 row layout — phone
SBTs already designed for ADR 0003 must either migrate to commitments
(re-issuance from existing per-phone bindings) or live in a legacy
namespace. Decision deferred to ADR 0007 implementation kickoff.

### Decision 2 — Consumption (e.g. voting) uses Semaphore-style proofs

A consuming dApp (e.g. an onchain ballot box) verifies that a voter:

```
Public inputs:  merkleRoot (current for source=certilia_v1),
                nullifierHash, externalNullifier (e.g. ballotId)
Private witnesses: identifier, secret, merklePath

Statements proved by zk-SNARK:
  1. Pedersen(identifier, secret) is a leaf in merkleRoot
  2. nullifierHash == H(externalNullifier, secret)
  3. (anti-replay) identifier and secret have not been revealed
```

The dApp records `nullifierHash` to prevent the same credential
voting twice in the same ballot. Different ballots produce different
nullifiers (via `externalNullifier`), so credentials are reusable
across votes but each vote is one-time per credential.

This is exactly the **Semaphore v4 primitive** (`@semaphore-protocol`
ecosystem, PSE, audited 2023+). Default circuit selection.

### Decision 3 — Selective disclosure for off-chain proofs

Some use cases want the user to prove a non-zero subset of their
credentials to a third party WITHOUT going through onchain
consumption — e.g., "prove to this dApp you own phone number ending
in XX12 without revealing the full number" or "prove your OIB starts
with 12345 because that's your municipality code".

For these, BBS+ signatures (the IETF draft "BBS Cryptographic Suite
v2023") on the issuer side allow per-attribute selective disclosure.
The verifier mesh signs a BBS+ credential containing the user's
identifier attributes; the user later derives a presentation proof
disclosing only the requested attributes.

This is **off-chain only** in this ADR. Onchain consumption uses
Semaphore (Decision 2) — BBS+ has no native onchain verifier
primitive on Gnosis and adding one is out of scope.

The mesh therefore issues two artifacts per attestation:
1. **Semaphore-style commitment leaf** for onchain anonymous
   consumption.
2. **BBS+ credential** for off-chain selective disclosure.

Both are signed by the same M-of-N verifier mesh (ADR 0004), so
the trust chain is unified.

### Decision 4 — Identifier still hashed and pepper-isolated in the mesh

The raw OIB / phone never leaves the mesh device, exactly as ADR 0005
specified. What changes:
- The mesh device computes `H(PEPPER || identifier)` as before, but
  also receives `secret_commit = Commit(H(PEPPER||identifier), secret)`
  from the user's wallet (the wallet generated `secret` locally and
  sent only the commitment).
- The mesh signs the issuance with the commitment, not the hash.
- The user's wallet retains `secret`, `H(PEPPER||identifier)` (or just
  `secret` plus a derivation path) in local storage so future
  Semaphore proofs can be regenerated. Loss of `secret` = loss of
  the credential; users must back up their wallet seed (which we
  already require via passkey continuity).

This preserves all GDPR mitigations from ADR 0005 — raw identifier
discarded in milliseconds — and adds the anonymity property.

### Decision 5 — Phase 5e is a research milestone, not a release

Unlike ADR 0005, this ADR does NOT commit to a calendar timeline.
The reasons:

1. Semaphore v4 + Gnosis Chain combo has not been benchmarked by us;
   circuit compile size, prover wall-clock on commodity hardware,
   and gas cost per verification are unknowns we will measure.
2. The credential-issuance circuit (which proves a Certilia
   `id_token` was validly signed by the FINA JWKS, then commits to
   the OIB inside) is an active research area — implementations
   exist (zk-OIDC, AnonAadhaar precedent) but production-grade
   audited circuits for OIDC are 2026-state-of-the-art and will
   continue to evolve.
3. Voting-grade auditability requirements (multi-party trusted setup
   for SNARKs, or PLONK-style universal setup with subjectively
   safe ceremony) need legal + cryptographic review beyond what
   the project has budget for today.

Implementation pace will be: ADR 0007 (concrete primitive selection,
benchmarks) → research-grade prototype → audit → production. Total
realistic horizon: 12–24 months. **Phase 5d (ADR 0005) ships with
the deterministic-hash design** as an intermediate step; users get
sybil-resistance now and migrate to anonymous consumption when
Phase 5e is production-ready.

## Consequences

### Positive

1. **Voting unlocked at the privacy level Croatian voters expect.**
   The chain reveals only "some real citizen voted YES on ballot X",
   not "Safe 0xABC voted YES on ballot X".
2. **GDPR posture upgraded** from "we hash identifiers" to "we hash
   identifiers AND the hash is committed-not-revealed onchain". The
   data-controller exposure shrinks accordingly.
3. **Composable with broader Croatian PII protection.** Other dApps
   building on top of our SBT get the privacy property for free; the
   anonymous-consumption is in the verifier circuit, not in their
   code.
4. **BBS+ off-chain track gives selective disclosure for non-voting
   use cases** — KYC-lite, age proofs, residence proofs without
   re-running national eID flow.

### Negative

1. **ADR 0003 SBT contract design becomes intermediate, not final.**
   Storage layout amendment will be a hard fork of the deployed
   contract. Plan migration carefully — anyone holding a phone SBT
   under the legacy schema must re-issue or live in a legacy
   namespace.
2. **Implementation complexity is in a different league.** Semaphore
   integration, Pedersen commitments, zk-SNARK circuit maintenance,
   trusted-setup ceremony coordination — none of these are
   skill-sets the team currently has. Either ramp up or partner
   with an established ZK shop (Privacy & Scaling Explorations, PSE,
   are the natural collaborator; their Semaphore + MACI work is
   the prior art).
3. **Audit burden is significant.** Voting-grade circuit audits run
   €50k–€200k from reputable firms (Veridise, Trail of Bits ZK
   practice, ZKsecurity.xyz). Budget must be raised before ADR 0007
   implementation can be considered production-bound.
4. **User experience adds steps.** Generating + persisting the
   credential `secret` is one more thing the wallet must back up
   alongside the passkey. Loss of secret = loss of credential =
   user must re-issue from scratch (Certilia re-auth + remint).
   Same continuity story as passkey backup; not new burden but
   adjacent.

### Neutral

1. **Mesh role unchanged.** ADR 0004's Android + CF Tunnel +
   StrongBox custody serves the new commitment-signing model just
   as well as the old hash-signing model.
2. **OAuth2 client_secret handling per ADR 0005 unchanged.** Same
   relay flow, same secret distribution.
3. **Voting dApps may be built by third parties.** The SBT contract
   exposing only `currentRoot` + `lastUpdateBlock` is sufficient for
   anyone to write a voting frontend; we are not gatekeeping by
   design.

## Open research questions (deferred to ADR 0007)

- **Tree depth and capacity.** Semaphore default is 20 levels (~1M
  leaves). Croatian eligible voters are ~3.7M; capacity needs ≥22
  levels per source. Impact on prover time and verifier gas?
- **Batched issuance vs per-mint root update.** Per-mint root updates
  are expensive; batched updates introduce delay between Certilia
  auth and on-chain visibility. Which is acceptable for the UX?
- **Trusted setup ceremony.** Groth16 needs per-circuit toxic-waste
  setup; PLONK / Halo2 enable universal setup but with higher
  verifier cost. Pick before circuit implementation starts.
- **Migration from ADR 0003 plaintext-hash design.** Forced migration,
  opt-in re-issuance, or dual-track? UX implications differ heavily.
- **Long-term key rotation.** If the mesh's BBS+ key compromises,
  all issued credentials in that key's epoch are at risk. Epoch
  rotation cadence and forward-secrecy story.
- **Cross-attestation linkability.** If the same OIB is used to mint
  both phone-OTP and Certilia credentials, are the two commitments
  linkable? Answer depends on whether the same `secret` is reused
  across sources or rotated; correct design rotates.

These are NOT blockers for ADR 0005 (Phase 5d) implementation. They
ARE blockers for production Phase 5e launch and will be answered in
ADR 0007 once the prototype yields concrete numbers.

## Implementation order (research-stage)

1. **Reading + benchmarking (current task).** Semaphore v4 docs,
   AnonAadhaar codebase, Sismo / Polygon ID architecture review.
   Build a toy Gnosis-deployment prototype to measure circuit
   verification gas.
2. **ADR 0007: concrete primitive selection.** Once benchmarks are
   in hand, pick Semaphore vs alternatives, document the choice with
   numbers.
3. **Circuit implementation prototype.** Off-mainnet; integrate with
   wallet.domovina.ai dev branch.
4. **Audit-ready implementation.** With budget secured.
5. **Production launch.** Coordinated with Phase 5d migration / dual-
   track decision.

## References

- ADR 0001 — Self-custody principle.
- ADR 0002 — Phase 5 attestation rationale.
- ADR 0003 — PhoneSBT contract (schema this ADR amends).
- ADR 0004 — Phase 5c Android verifier mesh.
- ADR 0005 — Phase 5d Certilia + GDPR scope expansion.
- Semaphore v4 documentation:
  https://docs.semaphore.pse.dev
- MACI (Minimal Anti-Collusion Infrastructure):
  https://maci.pse.dev
- AnonAadhaar (Indian national-ID zk precedent):
  https://anon-aadhaar.pse.dev
- Sismo (zk identity credentials):
  https://docs.sismo.io
- Polygon ID / iden3:
  https://github.com/iden3
- BBS+ Signatures IETF draft:
  https://datatracker.ietf.org/doc/draft-irtf-cfrg-bbs-signatures
- zk-OIDC research overview:
  https://eprint.iacr.org/2023/1042 (representative — not authoritative)
- Trusted setup ceremonies (Perpetual Powers of Tau):
  https://github.com/privacy-scaling-explorations/perpetualpowersoftau

## Implementation tracking

ADR was accepted 2026-05-26 as **design direction**, not buildable
spec. Phase 5e is research-stage; concrete implementation gated on
ADR 0007 (primitive selection benchmarks) and external partnership
(likely PSE) + audit budget.

| Decision / milestone | Status | Notes |
|---|---|---|
| D1: Commitment-not-hash onchain | ✅ Decided | Schema change to ADR 0003 storage layout; impl deferred |
| D2: Semaphore v4 for onchain voting | 🟡 Direction set | Primitive selection final in ADR 0007 |
| D3: BBS+ for off-chain selective disclosure | 🟡 Direction set | No native Gnosis verifier; off-chain track only |
| D4: Identifier still hashed + pepper-isolated in mesh | ✅ Decided (extends ADR 0005 D3) | Carried forward from ADR 0005 |
| D5: Phase 5e is research, not release | ✅ Decided | 12-24 month horizon, €50-200k audit budget required |
| Reading + Semaphore benchmarking | ⏳ Not started | First task in ADR 0007 prep |
| ADR 0007 primitive selection | ⏳ Not started | Triggered by benchmark numbers |
| PSE / iden3 / Sismo partnership outreach | ⏳ Not started | Pre-implementation prerequisite |
| Circuit prototype | ⏳ Not started | After ADR 0007 |
| Audit-ready implementation | ⏳ Not started | Requires audit budget secured |
| Production launch + migration coordination | ⏳ Not started | Coordinated with Phase 5d → 5e migration story |
| ADR 0003 storage forward-compatibility check | ⏳ Required before SBT contract code | `bytes32 identifier` + `uint8 schemaVersion` slot reservation suggested cross-reference |
