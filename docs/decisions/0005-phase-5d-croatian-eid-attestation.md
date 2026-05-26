# ADR 0005 — Phase 5d: Croatian eID attestation via Certilia mIN; eOI-as-passkey rejected; OAuth2 client_secret extends verifier mesh

**Status:** Accepted, awaiting implementation.
**Date:** 2026-05-26
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Inherits from:** ADR 0001 (self-custody), ADR 0002 (Phase 5 attestation rationale), ADR 0003 (PhoneSBT contract), ADR 0004 (Phase 5c Android verifier mesh).

## Context

One of the project's core long-term visions is **on-chain governance
that is cryptographically perfect AND maps each vote to a verified
real Croatian citizen** — sybil-resistant by construction, not by
trust. Phase 5 SBT (ADR 0003) is the foundation: a soulbound token
on the user's Safe whose `(holder, source, latest_at)` tuple is
queryable by any third-party dApp without our cooperation. ADR 0003
specified phone OTP as the first attestation source.

For voting use cases, phone OTP alone is insufficient. Under eIDAS,
verified phone numbers map to **Level of Assurance Low** at best —
prepaid SIM markets make the resource trivially purchasable, and the
sybil-resistance budget is bounded by SIM price not by population
size. Onchain voting credible enough to bind real-world decisions
needs **Level of Assurance High**, which in the Croatian regulatory
context maps to **qualified eID** — i.e. assertions issued under
eIDAS Article 8 high-LoA notification.

Croatia has two notified eID schemes in production as of 2026-05-26:

1. **Certilia mIN.** — mobile-only OIDC IdP operated by FINA,
   accepted by all Croatian e-government services. Authentication
   factor is the user's PIN + the device's secure element. LoA
   notified to EU Commission as **High** in 2021. UX: install app
   once, authenticate via PIN + biometric on any subsequent flow,
   browser redirect.

2. **eOI (elektronička osobna iskaznica)** — physical national ID
   card with contact + contactless chip. PKI certificates issued by
   AKD. LoA **High**. UX: USB CCID reader (~€10) + driver stack +
   middleware, or NFC on Android phones with custom integration.

Both qualify for sybil resistance binding. They differ on UX cost,
implementation cost, and ecosystem alignment with the existing wallet
stack. This ADR resolves which one to integrate first, why the other
is deferred indefinitely, and how the OAuth2 client credential custody
fits into ADR 0004's verifier mesh.

Background: Matija has an existing Flutter + Node.js implementation
of Certilia OIDC at https://github.com/stepanic/flutter_certilia
(2026-01) that handles the OIDC authorize → callback → token exchange
→ id_token verification pipeline. The Node.js portion is portable to
a Hono route running on the existing CF Worker backend; the Flutter
portion is irrelevant because wallet.domovina.ai is a React PWA.

## Decision

### Decision 1 — Certilia mIN. is Phase 5's second attestation source

Add `CertiliaAttestationV1` as a new source variant in the PhoneSBT
contract from ADR 0003 (the contract is misnamed but its `source`
enum was always envisaged as multi-valued). Rename the contract to
`CitizenshipSBT` in a coordinated migration with the existing phone
flow OR keep the deployed name and extend the enum; final pick
deferred to implementation start.

The Certilia flow mirrors the existing phone OTP flow, with three
substitutions in the protocol:

| Step | Phone OTP (ADR 0003) | Certilia mIN (this ADR) |
|---|---|---|
| Identity proof | Reverse-SMS OTP via otp.domovina.ai | OIDC `id_token` JWT signed by Certilia JWKS |
| Identifier hashed | `H(PHONE_PEPPER || phone)` | `H(OIB_PEPPER || oib)` |
| Off-chain assertion | Backend verifies OTP consumption | Backend verifies JWT signature + audience + iss + nbf/exp |
| On-chain attestation | Verifier mesh signs `(holder, phone_hash)` | Verifier mesh signs `(holder, oib_hash, source=certilia_v1)` |
| eIDAS LoA carried in SBT | low/substantial | **high** |

The SBT row layout grows a single `source` byte slot already
contemplated in ADR 0003 § "Storage layout" — no migration of
deployed phone-source SBT entries is required.

### Decision 2 — eOI-as-WebAuthn-passkey is REJECTED

Treating the eOI smart card as a WebAuthn authenticator was
evaluated and rejected. Reasons:

1. **Standard mismatch.** WebAuthn (CTAP2) authenticators sign
   origin-bound `clientDataJSON`+`authenticatorData`. eOI cards
   sign arbitrary hashes via PIV/ISO 7816 with X.509 cert chains
   anchored at AKD. There is no Croatian eID middleware that
   exposes the eOI as a CTAP2 authenticator, and writing one is
   approximately the same scope as writing a full PKCS#11 →
   browser bridge from scratch (deprecated in all major browsers
   since 2017).

2. **UX cost is catastrophic.** Users would need: a USB CCID
   reader (€10–€30, must be purchased), driver stack (opensc on
   Linux, AKD's middleware on Windows, broken on macOS Apple
   Silicon as of 2026-05-26), and a browser-side PKCS#11 module
   (Mozilla deprecation effectively closes this path). Mobile is
   NFC-only and requires custom Android integration; iOS Safari
   does not expose NFC to web pages at all. Conservative estimate:
   95%+ of prospective users would abandon enrollment.

3. **Engineering ROI inverted.** Building the smart card stack is
   3–6 months of work; Certilia integration is ~2 weeks. Both
   deliver LoA High, both bind to the same OIB, both are eIDAS-
   notified. There is no defensible reason to start with the
   harder path.

The eOI is NOT permanently excluded — see Decision 4 below for the
narrow case where it might re-enter the design later as an
"qualified electronic signature" backend assertion (NOT as a
passkey). That work is explicitly out of scope for Phase 5d.

### Decision 3 — OAuth2 client_secret extends ADR 0004 verifier mesh

ADR 0004 established that signing-key material lives in M-of-N
Android devices' StrongBox/Titan M2, reached via CF Tunnel, with
CF Workers acting as relay only. Certilia OIDC integration
introduces a new material type the mesh must hold: the
**OAuth2 client_secret** issued by Certilia for the application
registration.

The client_secret is not a cryptographic signing key — it is a
static credential used by the application during token exchange
(`POST /token` with `code` + `client_id` + `client_secret`).
Storing it in a CF Worker secret would re-introduce the same
"cloud provider holds production credential" trust assumption
that ADR 0004 explicitly rejected for verifier keys.

Three custody options were evaluated; option A is chosen for the
MVP, with option B as the production hardening target:

**Option A — single client_secret replicated on N Android devices (MVP).**
- Certilia issues ONE production client_id + client_secret.
- The secret is provisioned to each Android mesh device via the
  same out-of-band procedure used for verifier-key shares in ADR
  0004 (Matija manually loads on each device through Android
  Studio + ADB).
- At token-exchange time, the CF Worker forwards `code` to the
  currently-on-duty Android device over CF Tunnel; the device
  posts to Certilia and returns the `id_token` back through the
  Tunnel. Worker never sees the secret.
- Pros: simple; no Certilia cooperation needed; minimal latency
  (1 extra Tunnel round-trip ≈ 100–300ms in practice).
- Cons: any single device compromise leaks the full secret.
  Rotation requires re-provisioning N devices manually.

**Option B — N parallel client registrations (production target).**
- Certilia issues N independent (client_id, client_secret) pairs,
  one per Android mesh device.
- Each device holds only its own credential.
- Compromise of one device requires only that ONE pair to be
  rotated at Certilia; the other M−1 devices remain operational
  through the rotation.
- Pros: blast radius scales linearly with M instead of detonating
  on a single compromise.
- Cons: requires Certilia commercial conversation — current
  Certilia commercial terms do not document multi-credential
  registration as a supported feature, but bilateral discussion
  may unlock it for high-volume applications.

**Option C — threshold split via DKG (REJECTED).**
- Distribute key generation over the mesh so the client_secret is
  reconstructed only at token-exchange time.
- Cryptographically sound but operationally expensive: each token
  exchange requires interactive MPC over the mesh.
- Performance cost: 1–3 seconds added latency per Certilia
  authentication.
- Not justified — the OAuth2 client_secret is not a long-lived
  signing key for arbitrary attacker use; its blast radius is
  bounded by Certilia's per-application rate limits and detection
  capabilities. The added MPC complexity buys less security than
  Option B does.

For the mesh, Phase 5d implementation therefore:
- Reuses ADR 0004's Android device fleet (no new hardware).
- Adds a new "OIDC token exchange handler" component running on each
  device, listening for relayed code-exchange requests from CF Worker
  over CF Tunnel.
- Reuses ADR 0004's StrongBox-bound mTLS for CF Worker → Android
  authentication.
- The verifier-mesh signing key (for SBT attestation signatures) and
  the Certilia client_secret are isolated: separate storage, separate
  on-device threads, separate audit log lines.

### Decision 4 — eOI is reserved for FUTURE "qualified e-signature" enrollment in the verifier mesh

ADR 0004 left open the question of how *new* Android devices are
admitted into the verifier mesh as Matija scales beyond his personal
device count. The natural answer becomes available with this ADR:
**a candidate device's operator authenticates with a qualified
electronic signature from their eOI** (PIN + AKD cert chain proof
delivered over a one-time USB session with a desktop bridge), and
the mesh existing-quorum signs an admission certificate for the new
device. eOI's UX cost only happens once per mesh-operator lifetime,
not per end-user authentication, so the UX argument from Decision 2
does not apply.

This is **not** part of Phase 5d implementation scope. It is
reserved as a placeholder for ADR 0006 or 0007 once the mesh has
production traffic and the question of mesh expansion becomes
concrete. Documented here so future ADR authors do not re-evaluate
"eOI for end-user attestation" without remembering this rejection.

## GDPR scope expansion

OIB is **personal data** under GDPR Article 4(1) — it is a national
identifier defined by the OIB Act (NN 60/2008). Treatment must be
analogous to phone numbers:

- **Never store raw OIB.** Backend receives OIB inside the verified
  Certilia `id_token`, immediately hashes with a per-deployment
  `OIB_PEPPER` (`SHA-256(pepper || oib)`), discards the raw value
  before any database insert.
- **Only the salted hash is persisted** (in `wallet_certilia_bindings`
  table, schema mirroring `wallet_phone_bindings` from ADR 0003 § "Many-
  to-many model"). The hash is used onchain (as `oib_hash` argument
  to mint) and offchain for collision detection / re-verification
  counter aggregation.
- **No raw OIB leaves the device-token exchange boundary.** The
  Certilia `id_token` itself contains the raw OIB inside its claims;
  it is processed in memory inside the verifier mesh device, hashed,
  and discarded. The `id_token` is never written to disk on the
  Android device or in CF Worker logs.
- **Privacy notice must disclose** that we receive OIB from Certilia
  to compute the hash, and that we discard the raw value within
  ~milliseconds. Apply the analogous text to phone OTP from ADR 0003
  § "Privacy disclosures the UI must surface".
- **Data subject rights.** Hash-only storage limits "right to access"
  to revealing the hash itself; "right to erasure" works by deleting
  the binding row and refusing future mint attempts using that hash.
  Raw OIB never leaves Certilia's storage on our side, so erasure
  requests against the raw value are forwarded to Certilia.

## Onchain voting implications

This ADR is what unlocks the project's voting vision:

```
Voter eligibility = SBT(holder = voter.safeAddress, source = certilia_v1, latest_at >= election.attestation_window_start)
Vote weight       = 1 (one-citizen-one-vote, deduplicated by oib_hash uniqueness)
Vote secrecy      = vote payload is independently encrypted; the SBT proves
                     eligibility but does not link the vote to the citizen
```

The dApp consuming the SBT for voting does NOT need to know the
citizen's identity — only that this Safe holds a valid
`certilia_v1` SBT minted within the election's attestation window.
This is the cryptographic minimum for sybil-resistant onchain
voting with verified citizens, and it is achievable with the
existing PhoneSBT contract plus the source-enum extension.

For Croatian-citizen-only votes specifically, the dApp filters SBT
queries to `source = certilia_v1` only; phone-only attestations
do not qualify.

## Consequences

### Positive

1. **eIDAS High LoA available onchain** for the first time in the
   Croatian crypto ecosystem (per author's knowledge as of
   2026-05-26).
2. **Onchain voting vision unblocked** — Phase 5d delivers the
   missing primitive.
3. **Existing Certilia integration code reusable** — Matija's
   Flutter + Node.js implementation ports to the CF Worker backend
   with no new vendor risk.
4. **Decentralization invariant preserved** — Certilia client_secret
   never lands in cloud provider infrastructure (per Decision 3).
5. **Phase 5c verifier mesh investment leveraged** — same Android
   fleet, same CF Tunnel, same StrongBox-bound mTLS.
6. **eOI explicitly deferred not just postponed** — future authors
   have written rationale for why not to revisit, only when the
   *mesh operator enrollment* problem becomes the bottleneck.

### Negative

1. **Mesh now holds two material types.** Operational complexity
   grows: rotation, audit, monitoring must cover both signing key
   shares and the OIDC client_secret.
2. **Certilia is a single-point-of-failure for the high-LoA source.**
   Outage at FINA = no new Certilia SBT mints. Phone SBT (source =
   `phone_otp_v1`) remains independently mintable; the voting dApp
   can fall back to phone-source SBT if explicitly tolerant.
3. **OIB hashing must use a long-lived stable `OIB_PEPPER`.** Pepper
   rotation invalidates all prior hashes and breaks
   collision-detection history. Treat pepper as a permanent
   per-deployment constant; budget for at-most one rotation in the
   project's lifetime, behind a tooling-supported re-derivation
   step.
4. **Regulatory exposure grows.** Operating as a data processor for
   eIDAS-notified national ID receives more attention from
   regulators than phone-OTP processing. Pre-launch legal review
   with eIDAS specialist counsel is added to the Phase 5d critical
   path.

### Neutral

1. **Phone OTP path stays operational.** ADR 0003 + ADR 0004 are
   unchanged. Phase 5d is additive.
2. **SBT contract schema is forward-compatible.** No migration
   required for deployed phone-source rows.

## Implementation order (suggested)

Phase 5d is split into three milestones:

1. **5d-1 (backend OIDC adapter):** Hono route at
   `/api/attest/certilia/start` + `/api/attest/certilia/callback`.
   Token exchange is INITIALLY direct from CF Worker (not via mesh)
   to unblock the first-pass implementation, then refactored to
   Tunnel relay in 5d-2. Hash OIB with `OIB_PEPPER`, persist
   binding row, return signed mint request to wallet UI.
2. **5d-2 (mesh refactor):** Move Certilia client_secret from CF
   Worker secret to Android mesh device. CF Worker becomes pure
   relay for token exchange. Verifier-mesh signing key path is
   already on-mesh from ADR 0004 and stays put.
3. **5d-3 (SBT mint + UI):** Wallet UI flow ("Verificiraj identitet
   za onchain glasovanje" Settings row), SBT contract source enum
   extension if needed, ABI updates, GdR-compliant disclosure
   strings.

Total realistic estimate: 6–10 weeks calendar time, including
legal review.

## References

- ADR 0001 — No server-side recovery (self-custody invariant).
- ADR 0002 — Phase 5 PhoneAttestation contract (original mechanism,
  superseded for uniqueness by ADR 0003).
- ADR 0003 — Phase 5 PhoneSBT contract design (source enum,
  many-to-many bindings, verifier sig schema).
- ADR 0004 — Phase 5c Android verifier mesh (StrongBox custody,
  CF Tunnel, M-of-N quorum).
- Existing Flutter + Node.js Certilia integration:
  https://github.com/stepanic/flutter_certilia
- Certilia mIN public documentation: https://www.certilia.hr
- eIDAS Regulation (EU) 910/2014 Art. 8 (Levels of Assurance).
- OIB Act NN 60/2008 (OIB as personal identifier).
- GDPR (Regulation EU 2016/679) Art. 4(1), 9, 32.

## Open questions, deferred

- Should `phone_otp_v1` SBT entries auto-renew when a `certilia_v1`
  SBT is minted for the same `oib_hash`? Likely yes for UX (one
  high-LoA mint subsumes the lower-LoA proof), but contract
  semantics need careful thought to avoid double-burn races.
- Should the SBT carry the `certilia_v1` mint timestamp or just a
  monotonic counter? Time-bounded queries are useful for "valid
  during this election window" but expose minting cadence.
- Long-term: do we want the Certilia integration to be available
  to third-party dApps directly, via an "issue SBT on my Safe"
  intent built into Wallet, or only as part of wallet.domovina.ai
  itself? This affects ADR 0003 § "Trust model and blast radius"
  decisions about who can be a mint authority.

These are NOT blockers for Phase 5d-1 implementation start; they
will be resolved in subsequent ADR amendments or new ADRs once
implementation lands and concrete failure modes appear.
