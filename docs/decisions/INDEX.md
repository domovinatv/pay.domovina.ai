# Architecture Decision Records — DOMOVINA Wallet

This directory holds the architectural decisions that shape
**wallet.domovina.ai** and its sibling white-label tenants. Every
decision that materially shapes the product (security model, identity
primitives, multi-tenancy, on-chain attestation, voting) is recorded
here under a [standard ADR format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

**Why this exists.** This is a project with a long-horizon vision —
cryptographically perfect Croatian-citizen on-chain governance, built
on self-custody Safe smart accounts on Gnosis Chain — and a small
team. ADRs are the audit trail that lets future contributors, grant
reviewers, audit firms, and partner teams understand **why** each
decision was made, not just what code shipped.

The records below are immutable once `Accepted`. When a decision
changes, a new ADR supersedes the previous one; the old one stays as
history.

---

## Status legend

- ✅ **Implemented** — production code matches ADR.
- 🟢 **Partially implemented** — some decisions in the ADR are
  shipped; see the ADR's Implementation tracking table.
- 🟡 **Prerequisites done, core blocked** — supporting work has
  shipped but the central decision waits on an upstream blocker.
- ⏳ **Planned** — accepted but no implementation yet.
- 🔬 **Research direction** — design accepted as direction; concrete
  primitive selection or benchmarking still open.
- ➖ **Superseded** — replaced by a later ADR.

---

## ADR index

| # | Title | Date | Status | Implementation |
|---|---|---|---|---|
| [0001](0001-no-server-side-recovery.md) | No server-side wallet recovery (self-custody invariant) | 2026-04-09 | ✅ Accepted | ✅ Upheld in all subsequent decisions |
| [0002](0002-phase-5-onchain-phone-attestation.md) | Phase 5 onchain phone attestation (original rationale) | 2026-05-19 | ➖ Superseded by ADR 0003 | ➖ Mechanism replaced; rationale carried forward |
| [0003](0003-phase-5-sbt-design.md) | Phase 5 PhoneSBT contract design | 2026-05-22 | ⏳ Accepted | 🟢 Phase 4 prerequisites shipped; SBT contract blocked on ADR 0004 |
| [0004](0004-phase-5c-android-verifier.md) | Phase 5c verifier mesh (Android + StrongBox + CF Tunnel) | 2026-05-23 | ⏳ Accepted | ⏳ Single largest blocker — 0 code, hardware not procured |
| [0005](0005-phase-5d-croatian-eid-attestation.md) | Phase 5d Croatian eID via Certilia mIN | 2026-05-26 | ⏳ Accepted | ⏳ Phase 5d-1 (OIDC backend) immediately unblockable; 5d-2 blocked on ADR 0004 |
| [0006](0006-phase-5e-zkproof-anonymous-attestation.md) | Phase 5e zkProof anonymous attestation + voting | 2026-05-26 | 🔬 Accepted (direction) | ⏳ Research stage; 12-24mo + €50-200k audit budget |
| [0007](0007-brand-as-data-white-label.md) | Brand-as-data white-label architecture | 2026-05-26 | ✅ Accepted | ✅ Implemented; 3 sample tenants live (default, sportklub, zupa) |
| [0008](0008-multi-passkey-same-safe.md) | Multi-passkey, multi-domain Safe ownership | 2026-05-26 | ✅ Accepted | ✅ Implemented (intra-RP ExpandAccess + cross-TLD peer linking) |
| [0009](0009-iframe-sdk-third-party-embedding.md) | Iframe SDK for third-party dApp embedding | 2026-05-26 | ✅ Accepted | 🟢 MVP shipped; signMessage + in-iframe onboarding deferred |
| [0010](0010-open-wallet-vision.md) | Open-Wallet vision (wallet-wasp as seed for open-source WASP wallet template) | 2026-05-26 | 🔬 Accepted (vision) | ⏳ Incubation in `experiments/wallet-wasp/`; rename criteria documented |

---

## Dependency graph

```
┌─────────────────────────────────────────────────────────────────────┐
│ ADR 0001  Self-custody invariant                                     │
│           (negative invariant — applies to every subsequent decision)│
└─────────┬───────────────────────────────────────────────────────────┘
          │ binds all downstream decisions
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          DELIVERED                                   │
├─────────────────────────────────────────────────────────────────────┤
│ ADR 0007  Brand-as-data white-label ──┐                              │
│ ADR 0008  Multi-passkey same Safe ────┤── 3 tenants live             │
│ ADR 0009  Iframe SDK for dApps ───────┘   self-custody P2P validated │
└─────────────────────────────────────────────────────────────────────┘
                                  ┊
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       PHASE 5 — IDENTITY                             │
├─────────────────────────────────────────────────────────────────────┤
│ ADR 0002  Phase 5 rationale  ──[superseded]→  ADR 0003               │
│                                                                       │
│ ADR 0003  PhoneSBT contract design                                   │
│   ├─ Phase 4 prerequisites:                                          │
│   │     • otp.domovina.ai service ✅                                  │
│   │     • BindPhone.tsx UI ✅                                          │
│   │     • wallet_phone_bindings D1 table ✅                            │
│   └─ Phase 5 SBT contract ⏳ (blocks on ADR 0004)                     │
│                                                                       │
│ ADR 0004  Android verifier mesh  ←── CRITICAL PATH BLOCKER            │
│   └─ Hardware + CF Tunnel + StrongBox quorum protocol ⏳ (0 code)     │
│        │                                                              │
│        ├──→ unlocks ADR 0003 SBT contract mint authority              │
│        ├──→ unlocks ADR 0005 5d-2 OAuth2 secret custody               │
│        └──→ unlocks ADR 0006 zkProof commitment signer                │
│                                                                       │
│ ADR 0005  Phase 5d Certilia eID (eIDAS High LoA)                     │
│   ├─ 5d-1 (OIDC backend adapter) ⏳ UNBLOCKABLE TODAY                  │
│   ├─ 5d-2 (mesh refactor) ⏳ blocks on ADR 0004                       │
│   └─ 5d-3 (SBT mint UI) ⏳ blocks on ADR 0003 contract                │
│                                                                       │
│ ADR 0006  Phase 5e zkProof anonymous attestation                     │
│   └─ Research stage — Semaphore + BBS+ direction set                 │
│      Will require ADR 0007 (primitive selection) before code.        │
└─────────────────────────────────────────────────────────────────────┘
                                  ┊
                                  ▼
                          ┌───────────────────────┐
                          │ ONCHAIN VOTING        │
                          │ (cryptographic vision)│
                          └───────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                  STRATEGIC / META-DECISIONS                          │
├─────────────────────────────────────────────────────────────────────┤
│ ADR 0010  Open-Wallet vision                                         │
│   ├─ Incubates in experiments/wallet-wasp/ (WASP rewrite)            │
│   ├─ Inherits 0001 (self-custody), 0007 (brand-as-data), 0008, 0009  │
│   └─ Genericization → potential wasp-lang/open-wallet template       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The vision in one paragraph

**wallet.domovina.ai** is a self-custody EURe wallet on Gnosis Chain
that lets any Croatian citizen send and receive euros without seed
phrases, with Face ID as the only required authentication. Built on
Safe smart accounts and WebAuthn passkeys (ADRs 0001, 0008). White-
label-ready for partner organizations (ADR 0007). Embeddable into
any third-party dApp (ADR 0009). Cross-tenant linking so the same
Safe lives across multiple domains (ADR 0008). And — over the next
12-24 months — extends into **sybil-resistant, GDPR-compliant,
cryptographically anonymous on-chain governance** that maps every
vote to a verified real Croatian citizen via Certilia eID
(ADR 0005) and zk-SNARK proofs (ADR 0006) signed by a decentralized
verifier mesh that no cloud provider holds (ADR 0004).

The project's invariants are: **no server-side recovery, no seed
phrases, no cloud-held signing keys, no PII (phone / OIB) ever
written to disk in plaintext.**

---

## What's shipped today (2026-05-26)

The wallet at **wallet.domovina.ai** and its two white-label sample
tenants at **wallet-sportklub.pages.dev** and
**wallet-zupa.pages.dev** are live with:

- ✅ Self-custody EURe wallet (passkey-owned Safe on Gnosis Chain)
- ✅ Send + Receive (SEPA top-up via Monerium, P2P via EIP-681 deep
  links)
- ✅ Cross-device passkey recovery (4-layer flow validated)
- ✅ Activity infinite-scroll history page
- ✅ Per-wallet balance via Multicall3 batch fetch
- ✅ Wallet archiving + create-many discouragement modal
- ✅ Phone OTP binding (`/settings/phone`)
- ✅ "Dodaj passkey" — intra-RP multi-passkey on same Safe
- ✅ "Linkaj postojeći wallet" — cross-TLD N-to-N peer linking
- ✅ Brand-as-data white-label (3 sample brands)
- ✅ Iframe SDK MVP for embedded payments in third-party dApps

The next implementation horizon (~6-10 weeks once Phase 5d-1
prerequisites are gathered) is **Certilia mIN integration**, which
gives the wallet its first eIDAS High LoA identity primitive without
requiring the Android verifier mesh.

The longer horizon (~12-24 months) is **Phase 5e** — Semaphore-style
anonymous voting credentials, after the verifier mesh (ADR 0004) is
in production and an audit budget is secured.

---

## Public-facing summary

If you're reading this from outside the project (grant reviewer,
prospective integration partner, audit firm), you're at the right
place: this directory IS the engineering roadmap. The code is the
implementation; these ADRs are the why.

For a high-level project overview: see the main repo README at
`../../README.md` and the wallet README at `../../wallet/README.md`.

For contribution guidelines: see `../../CONTRIBUTING.md` (if it
exists in your checkout) or the project's GitHub repo.

Contact: Matija Stepanic — stepanic.matija@gmail.com — ITalk d.o.o.,
Croatia.
