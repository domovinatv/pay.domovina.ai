# ADR 0004 — Phase 5c verifier custody: Android multi-device with hardware-backed Keystore

**Status:** Accepted, awaiting implementation.
**Date:** 2026-05-23
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Supersedes:** ADR 0003 § "Verifier key custody and rotation" and ADR 0003 amendment 2026-05-22 (Raspberry-Pi proposal).
**Inherits from:** ADR 0001 (self-custody), ADR 0003 (PhoneSBT contract design).

## Context

ADR 0003 specified the PhoneSBT verifier key as a hot Cloudflare Worker
secret, with rotation gated by a 2-of-3 governance Safe. The
2026-05-22 amendment to ADR 0003 paused this choice: Matija raised the
option of physical-hardware custody and listed six sub-questions to be
resolved before Phase 5c code lands. This ADR resolves those six
sub-questions and codifies the implementation path.

The three candidates evaluated at Phase 5c kickoff were:

1. **CF Worker secret (ADR 0003 as written).** Zero hardware cost, well-
   integrated with the rest of the relay stack, but the private key
   lives in a multi-tenant cloud secret store. Even with full audit
   trails, the threat model "Cloudflare insider, support-tunnel
   compromise, or zero-day in KV" cannot be reduced to ε. Matija
   rejected this as inconsistent with the spirit of ADR 0001's
   self-custody posture — even though the verifier key cannot move
   user funds, having any onchain authority live in a tenant cloud is
   a brand and trust mismatch with the rest of the system.

2. **Linux mini-PC + USB HSM (YubiHSM2 / NitroKey HSM 2).** Gold-
   standard for hardware-bound signing keys. FIPS 140-2 Level 3 on
   YubiHSM2. Cost ~€700-1200 first year per location. Single physical
   device per office; redundancy means another HSM + another mini-PC.
   Tooling (PKCS#11, ykhsm-shell) is industry-standard but not
   familiar to our team. Replication of a hot-spare HSM requires
   either manual ceremony or a key-wrap export protocol — both of
   which are non-trivial to operate.

3. **Android with hardware-backed Keystore (this ADR).** Each verifier
   is a current-generation Android device (Pixel 6/7/8 line in initial
   deployment) whose signing key is generated inside the Titan M2
   secure element via the StrongBox-backed AndroidKeyStore API. The
   key is non-extractable by design — there is no API surface by which
   the OS, an installed app, or a rooted ROM can read the private bits
   out of the secure element. Pixel Titan M2 holds Common Criteria
   EAL5+ AVA_VAN.5 certification, the same tier used for billions of
   passkeys, Google Pay tokenizations, and Android Identity Credentials
   in daily production. For the threat model bounded by ADR 0003 §
   "Trust model and blast radius" (verifier compromise = sybil signal
   integrity loss, never user-fund loss), this matches the security
   posture of a dedicated HSM at roughly 40% lower 3-year TCO and with
   native multi-device redundancy.

Option 3 is selected.

## Decision

The Phase 5c verifier role is fulfilled by an **M-of-N quorum of
Android devices, each holding a non-extractable EC P-256 signing key
in hardware-backed StrongBox/Titan-M2-class secure element**, exposed
to the backend orchestrator over Cloudflare Tunnel.

Hard rules (binding):

1. **The verifier private key MUST be generated inside a hardware
   secure element with non-extractable storage.** The device-side
   verifier app generates the key with
   `KeyGenParameterSpec.Builder(...).setIsStrongBoxBacked(true)`. If
   the device cannot produce a StrongBox-backed key (e.g. pre-Pixel-6
   hardware, certain Samsung models with TEE-only Keystore), the
   device is **unsuitable as a verifier** and the enrollment app
   refuses to proceed. There is no software-key fallback.

2. **`M ≥ 2` and `N ≥ 3`** at all times in production. Single-device
   verification is prohibited; the contract MUST require at least two
   distinct verifier signatures to mint or refresh an SBT. A buffer of
   at least one extra device beyond M is maintained so a single device
   failure (battery, OS update, theft) does not degrade the quorum
   below the threshold.

3. **Verifier devices reside in at least two physical locations.** A
   farm of three Pixels stacked on the same desk is not a meaningful
   improvement over a single device; fire, burglary, or power loss
   take them all together. The minimum acceptable spread is two
   geographically distinct locations (Zagreb + Split or equivalent).

4. **Network exposure is Cloudflare-Tunnel-only.** Direct public IPv4
   binding (static or dynamic), port forwarding, or VPN-mesh exposure
   is prohibited. The motivations are equal: eliminate ISP business-
   plan dependency, inherit free DDoS protection, and constrain the
   reachable surface to a Cloudflare-mediated mTLS path that the
   governance Safe can revoke without touching any device.

5. **The `verifierSet[]` and `threshold` are owned by the same 2-of-3
   governance Safe that owns the PhoneSBT contract** (per ADR 0003 §
   "Mitigations"). No single key, including the relay EOA, can add or
   remove a verifier address. This is a hard constraint inherited
   unchanged from ADR 0003 — the multi-device design strengthens it,
   it does not relax it.

6. **Every enrolled verifier produces a Google Key Attestation cert at
   enrollment time, which is filed in the internal ops runbook with the
   verifier's address and physical-location label.** The cert proves
   the corresponding pubkey was generated inside StrongBox at
   enrollment time. Onchain verification of the attestation cert is
   explicitly NOT required at claim time (gas cost too high, attestation
   trust is moved to the governance-Safe `addVerifier` decision); the
   cert exists for post-incident forensics and to detect a future
   compromise of `addVerifier` itself.

7. **Decommissioning is a two-step process.** The governance Safe
   first submits `removeVerifier(address)`; only after that
   transaction confirms is the physical device factory-reset. Reversing
   the order leaves a window in which the contract still trusts a
   device that has lost its key.

## Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │  PhoneSBT contract  (Gnosis Chain, ADR 0003) │
                 │                                              │
                 │   verifierSet[] = [0xA, 0xB, 0xC]            │
                 │   threshold     = 2                          │
                 │                                              │
                 │   claim(phoneHash, deadline, [sigA, sigB])   │
                 │     ↳ recovers 2 distinct verifiers from sigs │
                 │     ↳ both must be in verifierSet[]          │
                 └─────────────────────────────────────────────┘
                                  ▲
                                  │ user-broadcast tx, gas-relayed by Worker
                                  │
            ┌─────────────────────┴─────────────────────────────┐
            │   Backend orchestrator (CF Worker)                │
            │   /api/sbt/claim                                  │
            │     1. POST { phoneHash, recipient, otp }         │
            │     2. validates OTP via otp.domovina.ai          │
            │     3. fan-outs sign-request to all N verifiers   │
            │     4. returns first M valid sigs to client       │
            └──────────────┬──────────────┬─────────────────────┘
                           │              │
                           │ mTLS via CF  │
                           │ Tunnel       │
                           ▼              ▼
         ┌─────────────────────────┐    ┌─────────────────────────┐
         │  Verifier #1 Pixel 6    │    │  Verifier #2 Pixel 6    │
         │  Zagreb office          │    │  Split (home)           │
         │                         │    │                         │
         │  Kotlin app (Ktor)      │    │  Kotlin app (Ktor)      │
         │  AndroidKeyStore.sign() │    │  AndroidKeyStore.sign() │
         │   ↳ StrongBox/Titan M2  │    │   ↳ StrongBox/Titan M2  │
         │  cloudflared service    │    │  cloudflared service    │
         └─────────────────────────┘    └─────────────────────────┘
                                                ┌──────────────────┐
                                                │ Verifier #3 Pixel 6│
                                                │ Rijeka (3rd party) │
                                                │  ... identical ... │
                                                └──────────────────┘
```

### Per-device software stack

- **Native Kotlin app** (Android Studio project, target SDK 34+, min
  SDK 31 to guarantee StrongBox availability on supported devices).
- **Embedded Ktor server** bound to `127.0.0.1`, single endpoint
  `POST /sign` that:
  - Accepts `{ payload_hash: bytes32, request_id: uuid }` JSON
  - Verifies a mTLS client cert (issued by our root) — only the
    orchestrator's cert is trusted
  - Calls `Signature.getInstance("SHA256withECDSA")` with a
    KeyStore-backed `PrivateKey`
  - Returns `{ signature, verifier_address, signed_at_unix }`
  - Logs `(request_id, payload_hash, verifier_address, signed_at)` to
    a local SQLite append-only table for post-incident forensics
- **cloudflared Android daemon** — official Cloudflare binary
  cross-compiled for arm64 Android, run as a `ForegroundService` with
  persistent notification ("DOMOVINA verifier active"). On boot the
  app registers `BOOT_COMPLETED` and re-launches the foreground
  service; Battery Optimization exemption is requested at first run.
- **Key generation** at first install only:
  - `KeyPairGenerator.getInstance(KEY_ALGORITHM_EC, "AndroidKeyStore")`
  - `KeyGenParameterSpec.Builder(alias, PURPOSE_SIGN).setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(DIGEST_SHA256).setIsStrongBoxBacked(true).setUserAuthenticationRequired(false).build()`
  - `setUserAuthenticationRequired(false)` is deliberate: the device
    is a headless server, no human is present to do biometric auth
    per-signature. The hardware-binding is the protection; user-
    presence is not in the threat model for an in-office signer.

### CF Tunnel ingress

- Each device runs `cloudflared tunnel run` with a per-device tunnel
  credential.
- DNS records: `verifier-1.internal.domovina.ai`, `verifier-2…`,
  `verifier-3…`, all bound to their respective tunnel.
- Cloudflare Access policy on each hostname: only the orchestrator
  Worker's signed JWT (issued via service-token mechanism) is allowed
  through ingress. Tunnel + Access together mean even a public DNS
  lookup of `verifier-1.internal.domovina.ai` returns a CF edge IP
  that immediately rejects any request without the orchestrator JWT.
- Tunnel credentials are issued by the governance Safe operator
  (Matija) and stored on each device's internal storage encrypted at
  rest via `EncryptedSharedPreferences`. Credential rotation procedure
  is in the internal runbook; loss-of-device protocol is to revoke the
  tunnel credential in the CF dashboard before any further action.

### Backend orchestrator

- New CF Worker route `/api/sbt/claim` (in the existing
  `monerium.domovina.ai` / `mpt.domovina.ai` Worker).
- On request:
  1. Validate OTP via `otp.domovina.ai`.
  2. Compute the EIP-712 digest per ADR 0003's claim authorization
     domain (`PhoneSBT` domain, `(phoneHash, recipient, deadline)`).
  3. Issue a CF Access service-token JWT for each verifier hostname.
  4. Fan-out POST to all N verifiers in parallel with a 3s per-
     verifier timeout.
  5. Collect the first M valid signatures (validated against the
     known verifier-set pubkeys server-side as a fast-fail before
     forwarding).
  6. Return `{ signatures: [sigA, sigB], verifier_addresses: [0xA,
     0xB], deadline, recipient, phoneHash }` to the wallet.
- The Worker holds NO signing key — its onchain authority is zero,
  consistent with ADR 0001. It is a routing/quorum layer only.

### Contract changes from ADR 0003 single-verifier sketch

```solidity
contract PhoneSBT is ERC721, ERC721Soulbound, EIP712, Ownable2Step {

    // M-of-N quorum (ADR 0004 supersedes ADR 0003 single verifier).
    address[] private _verifiers;
    mapping(address => bool) public isVerifier;
    uint256 public threshold;

    event VerifierAdded(address indexed verifier);
    event VerifierRemoved(address indexed verifier);
    event ThresholdChanged(uint256 oldT, uint256 newT);

    function addVerifier(address v) external onlyOwner { ... emit; }
    function removeVerifier(address v) external onlyOwner { ... emit; }
    function setThreshold(uint256 t) external onlyOwner {
        require(t >= 1 && t <= _verifiers.length, "bad_threshold");
        ... emit;
    }

    function claim(
        bytes32 phoneHash,
        address recipient,
        uint256 deadline,
        bytes[] calldata signatures
    ) external {
        require(block.timestamp <= deadline, "expired");
        require(signatures.length >= threshold, "below_threshold");

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            CLAIM_TYPEHASH, phoneHash, recipient, deadline
        )));

        // Track distinct verifiers in this batch — no replay within batch.
        address[] memory seen = new address[](signatures.length);
        uint256 distinctCount = 0;
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            require(isVerifier[signer], "not_verifier");
            for (uint256 j = 0; j < distinctCount; j++) {
                require(seen[j] != signer, "dup_signer");
            }
            seen[distinctCount++] = signer;
        }
        require(distinctCount >= threshold, "below_threshold_post");

        _doClaim(phoneHash, recipient);
    }
}
```

Gas cost vs single-verifier path: each additional signature is
~6,000 gas (ECDSA recover + dedupe loop). For M=2 the total claim
gas is ~120k vs ADR 0003's ~110k — negligible at Gnosis's ~$0.0001
per claim.

Replay protection: the existing per-`(phoneHash, deadline)` nonce
guard in ADR 0003 remains. Distinct-signer enforcement above prevents
a single verifier from being counted twice in a single submission.

## Trust model and blast radius — deltas from ADR 0003

ADR 0003 § "Trust model and blast radius" is the binding statement of
what a verifier-key compromise can and cannot do; everything there
still applies. The deltas introduced by this ADR:

**Tightened by this ADR:**

- **Sybil compromise now requires `M ≥ 2` concurrent device
  compromises.** Stealing one Pixel + extracting its Titan M2 chip
  does not yield any onchain authority. The attacker would need to
  physically compromise M devices in M distinct locations and
  simultaneously bypass StrongBox on each — an attack surface that
  bears no resemblance to "exfiltrate one cloud KV value."
- **Geographic separation means a single physical-realm attack
  (office burglary, fire, raid) cannot reach the threshold.**
- **Tunnel-only network exposure** removes ISP-level interception
  and direct port-scan attack vectors entirely.

**Unchanged from ADR 0003:**

- A verifier-quorum compromise (if it ever happened) still cannot
  touch any user Safe, move user funds, modify Safe owners, or
  prevent a user from continuing to transact. Blast radius is
  bounded to sybil-signal integrity, and the v2-contract recovery
  procedure in ADR 0003 § "Compromise-recovery" applies identically.
- The contract `owner()` remains the same 2-of-3 governance Safe.
  No path to single-actor governance is opened by this ADR.
- The relay EOA's role is unchanged: gas-pay onchain calls signed
  by the user. It holds no SBT authority.

## Operational concerns

### Background-service hardening

Android aggressively kills background processes. The verifier app
MUST use:

- `Service.startForeground(notification)` with `FOREGROUND_SERVICE`
  permission and the persistent notification ("DOMOVINA verifier
  active"). This is non-negotiable; a background-only signer will
  drop offline within hours on any modern Android.
- Battery-optimization exemption requested via
  `Intent(ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)` at first run.
  Operator must approve; refusal blocks enrollment.
- `BOOT_COMPLETED` broadcast receiver to relaunch the foreground
  service after OS update reboots.
- `ConnectivityManager.NetworkCallback` to detect Wi-Fi/4G drops and
  trigger cloudflared reconnect.
- Power supply: each device on its own consumer-grade UPS (€30-50)
  to ride out brown-outs without rebooting.

### Monitoring

- Each verifier exposes `GET /health` (no auth) over the same CF
  Tunnel hostname. Returns `{ ok: bool, uptime_s, last_sign_unix,
  battery_pct, signal_strength }`.
- Third-party uptime monitor (Better Uptime free tier or
  UptimeRobot) pings each `/health` every 60s.
- A degraded verifier (any one of N down) triggers a non-critical
  alert. Two of N down triggers a critical page.

### Audit log

- Per-device SQLite append-only table (`signed_claims`) holding
  `(request_id, payload_hash, verifier_address, signed_at)`.
- Worker also writes the orchestrator-side equivalent into a CF D1
  table.
- Daily job (Worker cron) computes a Merkle root over the day's
  claims and pins it to IPFS (via Pinata or Cloudflare R2 with
  CIDv1). Root is committed onchain via a `claimsRollupRoot` event
  on a separate `AuditLog` contract (no auth, anyone can verify).
- The combination of per-device logs + orchestrator log + IPFS-
  pinned Merkle root means a single party rewriting history would
  diverge from the other two and the rollup root would mismatch.

### Lifecycle planning

- Pixel 6: security updates through 2026-10. **Already inside
  end-of-life window — do NOT use as initial deployment hardware
  for this ADR.**
- Pixel 7: security updates through 2027-10. Acceptable for a
  18-month initial deployment; replacement schedule must be on the
  ops calendar.
- **Pixel 8 (or later) is the recommended initial deployment
  hardware** — security updates through 2030-10, giving ~5 years
  of supported lifecycle from this ADR's date.
- Replacement procedure documented in the internal runbook;
  follows the decommissioning hard rule (§ Decision rule 7).

### Termux prototype phase

Before native-app investment, a **Termux-based prototype on a
single device** validates the end-to-end flow:

- `pkg install nodejs openssl`
- Node script generating a software P-256 key, exposing `/sign`
  on localhost via a tiny HTTP server, exposed via the same
  `cloudflared` daemon
- The orchestrator + contract changes are exercised against this
  software-key prototype on Gnosis Chiado testnet.

This is **not production**: the prototype uses a software key, which
is forbidden by hard rule 1. The prototype exists to debug the wiring
(tunnel routing, orchestrator fan-out, contract recover loop) before
investing in the native Kotlin app. Once green on testnet, the
software prototype is destroyed and the native app build begins.

## Resolutions of the six sub-questions from [[project-phase5-hardware-verifier-intention]]

1. **Where do verifier devices live physically?**
   Three locations, minimum two distinct (initial deployment:
   Zagreb office, Split residence, and a third location to be
   confirmed). Each location is responsible for power continuity
   (consumer UPS) and physical security (locked space, no public
   access). Specific addresses recorded in the internal ops runbook
   only, never committed to git.

2. **How is the signing key generated and bound to hardware?**
   Generated in-device by AndroidKeyStore with
   `setIsStrongBoxBacked(true)`. Non-extractable by API construction.
   Google Key Attestation certificate captured at enrollment and
   filed in runbook. Key parameters: `secp256r1` / `EC P-256`,
   `SHA256withECDSA`, `setUserAuthenticationRequired(false)`,
   `setRandomizedEncryptionRequired(false)` (not needed for signing).

3. **Who has physical access to each device?**
   Each device has exactly one human custodian, listed in the
   runbook. Devices are powered on, kept on charger, no SIM card
   (no SMS authority path to abuse), Google account is a dedicated
   ops account with hardware-key 2FA enrolled. Custodian's role is
   "do not unplug it, alert ops if device is missing, allow
   battery replacement when scheduled" — no signing-key access is
   required from custodians; they cannot extract the key even if
   they tried.

4. **How is network exposure secured?**
   Cloudflare Tunnel only, with Cloudflare Access service-token JWT
   gating, mTLS client-cert termination at the device, no inbound
   ports opened on any consumer router. Tunnel credentials rotated
   on each device-replacement event and on operator-discretion
   schedule (target: annually).

5. **What is the rotation / replacement procedure?**
   Two-step decommission (governance tx → device factory reset),
   followed by enrollment of a replacement device (governance tx
   `addVerifier`) before retiring the old slot. At no point does
   the active quorum drop below the threshold during a planned
   replacement. Emergency response (device theft / suspected
   compromise) skips the symmetry: governance Safe immediately
   submits `removeVerifier`; replacement enrollment happens at
   leisure once the quorum is back above threshold.

6. **What is the failure / recovery posture if multiple verifiers
   are lost at once?**
   `N - M` simultaneous failures are tolerated transparently. At
   `N - M + 1` simultaneous failures, the orchestrator returns
   `503 verifier_quorum_unavailable` to the wallet, which surfaces
   "Recovery telefon trenutno nedostupan, pokušaj za nekoliko
   minuta" to the user. New SBT mints are paused but existing SBTs
   remain valid and queryable. If `M` or more verifiers are lost
   to confirmed compromise (not just downtime), the ADR 0003
   compromise-recovery procedure applies: governance Safe deploys
   `PhoneSBT v2` with a fresh `verifierSet`, third-party consumers
   update the contract address they query, v1 becomes a historical
   record. There is no migration of holders; users re-claim their
   slots on v2.

## Open questions deferred to implementation

- **Initial third-location custodian.** Two locations are confirmed
  (Zagreb office, Split residence). A third operator with hosting
  responsibility for the third device must be identified and named
  in the runbook before deployment moves out of testnet. Candidates
  discussed: a co-founder's residence, a trusted board member, or
  a self-hosted colocation rack with controlled physical access.
- **Audit log retention horizon.** The Merkle-root-to-IPFS-to-onchain
  rollup is forever. The per-device SQLite logs and the orchestrator
  D1 table grow without bound. Initial retention: 2 years rolling,
  then archive to compressed cold storage. Reconsider when storage
  pressure becomes real.
- **Backup spare device.** A fourth Pixel 8 (cold spare, pre-enrolled
  with key generated but not yet added to `verifierSet`) is desirable
  for fast-swap response. Initial deployment ships with three; spare
  decision deferred to operational experience.
- **Wallet-side UX for quorum-unavailable.** The current Phase 7 phone
  binding wizard's `kind: 'error'` state will catch the
  `503 verifier_quorum_unavailable` response; copy may need a softer
  spelling for this specific case ("Provjera trenutno nedostupna,
  pokušaj za par minuta" rather than a hard error tint).

## Phasing

- **Phase 5c-prep (~1 session).** Update PhoneSBT contract sketch to
  M-of-N. Update orchestrator API contract. Write the Kotlin app
  skeleton (build.gradle, manifest, foreground service, Ktor
  endpoint). Termux software-key prototype to debug end-to-end on
  Chiado testnet.
- **Phase 5c-build (~3-4 sessions).** Native Kotlin app with
  AndroidKeyStore signing. cloudflared integration as foreground
  service. Health endpoint + audit-log persistence.
- **Phase 5c-enroll (~1 session, paced across days).** Acquire three
  Pixel 8 devices. Install verifier app on each. Generate keys in
  StrongBox. Capture attestation certs. Issue tunnel credentials.
  Governance Safe submits three `addVerifier` transactions on
  Chiado.
- **Phase 5c-go (~1 session).** PhoneSBT v1 deployed to Gnosis
  mainnet with M-of-N verifier set. Wallet UI for `bind-phone`
  flips to the SBT-claim path. Backend orchestrator routes
  through the verifier farm.
- **Phase 5c-soak (~30 days, passive).** Watch the audit logs and
  the Better Uptime dashboards. No code changes during soak unless
  a critical issue surfaces.

## Non-decisions

This ADR does **not**:

- Relax the strict self-custody posture of ADR 0001. Verifier
  compromise still cannot reach any user Safe.
- Introduce any new authority over user funds. The verifier farm
  authorizes SBT claims only; it has no execTransaction path.
- Change the EIP-712 domain or the claim authorization payload
  shape from ADR 0003. Single-signer ADR-0003 implementations
  remain wire-compatible with the M-of-N path used here — only the
  contract's verification side changes.
- Specify per-device firmware audit. Devices ship with stock
  Pixel images; verified-boot is required by StrongBox itself and
  is not an additional ADR-level constraint.
- Mandate specific custodians or addresses for the governance Safe.
  Inherits ADR 0003 § Mitigation's 2-of-3 Safe identities.

## References

- ADR 0001 — `docs/decisions/0001-no-server-side-recovery.md`
  (binding self-custody rules; this ADR inherits unchanged).
- ADR 0002 — `docs/decisions/0002-phase-5-onchain-phone-attestation.md`
  (early attestation design; superseded by ADR 0003 + this ADR).
- ADR 0003 — `docs/decisions/0003-phase-5-sbt-design.md`
  (PhoneSBT contract; this ADR supersedes only its single-verifier
  custody section + the 2026-05-22 amendment).
- Memory pointers (private): `[[project-phase5-hardware-verifier-intention]]`,
  `[[project-phase5-onchain-attestation]]`,
  `[[project-self-custody-principle]]`.
- Cloudflare Tunnel docs:
  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- Cloudflare Access service tokens:
  https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- Android Keystore + StrongBox API:
  https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder#setIsStrongBoxBacked(boolean)
- Pixel Titan M2 security model:
  https://security.googleblog.com/2021/10/pixel-6-setting-new-standard-for-mobile.html
- Common Criteria certification for Titan M2:
  https://www.commoncriteriaportal.org/files/epfiles/anssi-cible2023_67en.pdf

## Implementation tracking

This ADR is the **single largest blocker** on the critical path —
ADR 0003 (PhoneSBT) and ADR 0005 (Certilia 5d-2) both depend on
the mesh being operational, and ADR 0006 (Phase 5e zkProof)
inherits the mesh as commitment signer. Implementation is 0%; all
six sub-questions are answered in the ADR but no hardware
procurement, no CF Tunnel setup, no Android app code, no quorum
protocol implementation exist yet.

| Sub-question (per ADR) | Design status | Implementation status |
|---|---|---|
| Q1: How many devices in the mesh? | ✅ Answered (M-of-N with M=2, N=3 to start) | ⏳ Not procured |
| Q2: Where does each device live? | ✅ Answered (Matija + 1 trusted operator + 1 cold spare) | ⏳ Not provisioned |
| Q3: How does CF Worker reach them? | ✅ Answered (CF Tunnel + Access service tokens) | ⏳ Not configured |
| Q4: Quorum protocol? | ✅ Answered (TSS via Shamir SSS over Ed25519 / ECDSA secp256k1) | ⏳ Not implemented |
| Q5: Key rotation cadence? | ✅ Answered (quarterly, governance-Safe gated) | ⏳ N/A until in production |
| Q6: Disaster recovery? | ✅ Answered (cold spare reactivation + re-issuance) | ⏳ N/A until in production |

**ROI argument**: one mesh implementation unlocks BOTH ADR 0003
(phone SBT minting) AND ADR 0005 (Certilia OAuth2 secret custody).
Single largest infrastructure ROI per implementation hour in the
project. Estimated effort: 2-4 months calendar time (hardware
procurement + Android app + protocol implementation + dry-run
exercises), assuming the ADR design is implemented as written.
