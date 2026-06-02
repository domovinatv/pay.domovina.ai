# Plan — Porting the passkey-owned wallet to Solana (Squads / LazorKit)

> **Status:** 🔬 Research direction (no implementation). Produced 2026-06-02
> by an autonomous multi-agent research loop (Firecrawl + WebSearch, 6
> research dimensions → 4 adversarial verifications → synthesis).
> **Scope:** feasibility + architecture only. Nothing in here is built.
> **Reference system being ported:** [`wallet/`](../../wallet/) —
> `wallet.domovina.ai`, the live passkey-owned Gnosis Safe EURe wallet
> ([send validated on a real tx 2026-05-22](../decisions/0001-no-server-side-recovery.md)).

---

## 0. The question

> Can we build an *analogous* self-custody multisig wallet on **Solana**
> using the **Squads protocol** as the Safe-equivalent, with passkeys as
> the account authority, a gasless relay, and a euro stablecoin — the same
> way `wallet.domovina.ai` is built on Gnosis with Safe?

**Bottom line: yes — `feasible-with-caveats`.** Every pillar of the Gnosis
wallet maps to a *live Solana mainnet primitive* today. The two formerly
fatal blockers are both gone:

1. **On-chain P-256 verification exists.** The **secp256r1 SigVerify
   precompile** (SIMD-0075) is `Active on Mainnet Beta` since **epoch 800 /
   slot 345,600,000 (June 2025)**, program
   `Secp256r1SigVerify1111111111111111111111111`, feature gate
   `srremy31J5Y25FrAApwVb9kZcfXbusYMMsvTK9aWv5q`. This is the direct
   **RIP-7212 analogue** — adversarially verified `confirmed`.
2. **A euro stablecoin is live on Solana.** Circle **EURC**, native SPL,
   MiCA-compliant, mint `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr`,
   6 decimals, legacy SPL Token program.

But there is **one hard architectural caveat** that reshapes the design and
flips the headline finding about Squads:

> A WebAuthn passkey produces a **P-256** signature, which can **never** sign
> a Solana transaction envelope (Solana requires **Ed25519**). The precompile
> only *verifies* the P-256 signature as a sibling instruction; an on-chain
> program must *introspect* that result and gate a PDA vault on it.
>
> **Stock Squads v4 members are Ed25519-only and the Squads program does not
> read the secp256r1 precompile.** So you **cannot** get strict
> passkey-as-authority self-custody by pure composition of Squads + precompile
> + relayer with zero Rust. You need a **custom on-chain Rust program** — and
> there is already an audited, mainnet one that does exactly this:
> **LazorKit `program-v2`**.

**Recommendation:** the Safe-equivalent should be a **fork of LazorKit
`program-v2`**, not Squads. Squads is reserved for a *future* M-of-N quorum
need only (our actual model is threshold-1 redundancy, which LazorKit's
multi-authority covers more simply). See §3.

---

## 1. Pillar-by-pillar mapping (Gnosis → Solana)

| # | Gnosis pillar | Solana equivalent | Conf. | Key risk |
|---|---------------|-------------------|-------|----------|
| 1 | **Passkey = account authority** (P-256 → `SafeWebAuthnSigner` ERC-1271, verified via RIP-7212) | **secp256r1 precompile** + custom/forked smart-wallet program that introspects it via the **Instructions sysvar** and gates a PDA vault. LazorKit stores a 145-byte secp256r1 authority record (credId hash + 33-byte compressed pubkey + rpIdHash). | high | Not possible with stock Squads (Ed25519 members). WebAuthn sig must be DER→raw `r‖s`, **low-S normalized** (precompile *rejects* high-S), pubkey 33-byte compressed. No cheap sBPF fallback (~42M CU) — hard-depends on the precompile, which is now live. |
| 2 | **Counterfactual address** (CREATE2 predict-before-deploy, receive before deploy) | **PDA**. Squads vault: `["multisig", multisigPda, "vault", index]`; LazorKit: `["wallet", user_seed]` + `["vault", wallet_pubkey]`. Off-curve, deterministic, computable client-side before any tx. | high | SPL needs a rent-funded **ATA** (`0.00203928 SOL`) to exist before tokens land — no zero-cost receive like ERC-20. Mitigate with `createAssociatedTokenAccountIdempotent` (relayer pays). Squads *Smart Account* counter-derivation (u128 `settings_seed`) is **not** client-predictable — prefer v4 `createKey` or LazorKit `user_seed`. |
| 3 | **Multisig smart account** (Safe 1/1 multi-owner; `addOwnerWithThreshold(s,1)`) | **LazorKit multi-authority** (`addAuthority`, RBAC Owner/Admin/Spender, threshold-1 redundancy) — recommended. Or **Squads v4** threshold-1 single-member + `AddMember` — only if true M-of-N quorum is needed. | high | Verified: Squads v4 `invariant()` has **no min-2-members rule** — threshold-1 single member is valid; `AddMember` works (autonomous via config-tx+approve, controlled via config_authority). But passkeys can't be Squads members natively → a Squads path *still* needs a custom secp256r1 shim, negating its advantage. |
| 4 | **Gasless relay** (CF Worker EOA submits signed `execTransaction`, pays gas, holds no authority; KV 5/day) | **CF Worker as Ed25519 fee-payer** (tx account index 0). Native fee-payer/signer separation. Relayer is the **sole Ed25519 signer**; passkey rides as instruction data. `@solana/kit` (or web3.js + `nodejs_compat`). | high | *Cleaner* than Gnosis (no deploy-on-first-send dance). Octane (`anza-xyz/octane`) is the design blueprint but **archived 2026-04-20** — copy the validate-then-sign discipline, roll your own. CF Worker CPU limits → confirmation polling likely needs a **Durable Object** (per the existing SSE-on-Workers finding). |
| 5 | **Euro stablecoin** (Monerium EURe + SEPA mint-to-Safe rail) | **Circle EURC** (mint `Hzwqb…DKtr`, 6 dp, legacy SPL Token `TokenkegQ…`). | medium | **Not a drop-in.** Monerium EURe is **not on Solana** (no roadmap). EUROe is **dead** (Paxos → redemption-only). Circle Mint is **institutional**, not per-wallet IBAN — retail SEPA→EURC must route through a 3rd-party on-ramp (Transak/MoonPay/Privy). Bridging EURe is unclean (CCTP = USDC-only; Wormhole = wrapped non-redeemable). |
| 6 | **Strict self-custody** (no server key with on-chain authority; server recovery permanently rejected) | **PDA-owned vault gated solely on the precompile + program logic** (LazorKit pattern). Relayer = fee-payer only, provably no fund authority. Backend stores only public info. | high | Two integrity conditions: (a) program **must be immutable or timelock-governed** — an upgrade authority is a custody hole even if the relayer is fee-payer-only; (b) **reject the Para/Privy/Turnkey MPC pattern** (passkey unlocks a *server-held* Ed25519 key) — custodial-adjacent, violates [ADR 0001](../decisions/0001-no-server-side-recovery.md) / [self-custody principle](../decisions/0001-no-server-side-recovery.md). Replay protection = LazorKit's per-authority u32 **odometer** (not the unreliable WebAuthn hardware counter). |

---

## 2. The central divergence from the Safe model

On **Gnosis**, the passkey *is* the signer: the `SafeWebAuthnSigner` contract
is the Safe's owner, and `execTransaction` validates the WebAuthn signature
in-contract via ERC-1271 + RIP-7212. The relayer just wraps and submits.

On **Solana**, the curves are incompatible (P-256 vs Ed25519). The passkey
is **never a transaction signer** — it becomes an **in-instruction
authorization proof**:

```
Transaction (1 Ed25519 signature only: the relayer/fee-payer)
├─ ComputeBudget: set CU price + limit
├─ Secp256r1SigVerify precompile ix
│     carries (33-byte compressed pubkey, 64-byte raw r‖s sig, message)
│     referenced by offset structs (sig/pubkey/message instruction index)
└─ SmartWallet "Execute" ix  (LazorKit program, our fork)
      reads the Instructions sysvar → confirms the precompile ran with the
      expected pubkey + message; recomputes the WebAuthn challenge
      (= digest of slot ‖ payer ‖ accounts ‖ odometer ‖ program_id ‖ ix);
      base64url-compares it inside clientDataJSON; checks authenticatorData
      UP/UV flags + rpIdHash against the stored authority; checks odometer
      freshness + slot within ~150 → CPIs transferChecked(EURC) from the
      vault PDA via invoke_signed.
```

The relayer holds **no authority**: the program rejects the execute unless
the precompile confirms a valid P-256 signature over the tx-bound message, so
a relayer-only transaction (no valid passkey assertion) cannot move funds.
This satisfies the self-custody invariant exactly — *provided* the program is
immutable/timelocked and the challenge truly binds to the current tx (the #1
code-review item, see §6).

---

## 3. Why LazorKit, not Squads (and when Squads earns its keep)

`wallet.domovina.ai`'s real model is **threshold-1, multi-owner for
redundancy** ([multi-passkey ADR 0008](../decisions/0008-multi-passkey-same-safe.md)) —
*not* an approval quorum. For that model:

- **LazorKit `program-v2`** (MIT, Pinocchio/zero-copy, **Accretion
  Labs-audited**, mainnet `LazorjRFNavitUaBu5m3WaNPjU1maipvSW2rZfAFAKi`,
  devnet `FLb7fyAtkfA4TSa2uYcAT8QKHd2pkoMHgmqfnXFXo7ao`) **already implements
  pillars 1, 2, 4 and 6 out of the box**: passkey-as-on-chain-authority via
  the precompile, counterfactual PDA vault, gasless paymaster, odometer
  replay protection, multi-authority (= multi-passkey recovery), session keys
  (ephemeral Ed25519 for cheap repeat actions). Real cost: passkey execute
  ~`9,441 CU`, `0.000005 SOL/tx`; full wallet setup ~`0.002713 SOL` (~$0.41).
- **Squads v4** (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, AGPL-3.0,
  OtterSec/Neodyme/Certora-audited, ~$10B+ secured) is the *Safe-equivalent
  for genuine M-of-N quorum*, but **members are Ed25519-only**. Passkey-gating
  a Squads vault requires a bespoke secp256r1 signer-member shim anyway, so
  Squads costs *more* custom Rust than LazorKit for our model and buys
  nothing we need yet.

So Squads is **secondary / future-only**: adopt it if/when we want true
multi-party quorum (e.g. organizational treasuries). Track
[`smart-account-program`](https://github.com/Squads-Protocol/smart-account-program)
(`SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG`) — rent-free counterfactual
accounts + atomic policies, with a *roadmapped* (not shipped) passkey member;
if Squads ships a native P-256 member, re-evaluate.

> **Rejected:** the MPC/session-key path (Para/Privy/Turnkey/Dynamic). It
> needs **zero custom Rust** — the passkey just unlocks a server-/MPC-held
> Ed25519 key that does the signing — but that inserts a non-self-custodial
> key into the path. It is the Solana equivalent of the
> [permanently-rejected](../decisions/0001-no-server-side-recovery.md)
> server-recovery design. **Do not adopt.**

---

## 4. Simplest path

Custom Rust **is** required (see §0/§2/§3). The simplest path is therefore
**adopt-and-configure, not greenfield:**

1. **Fork** `lazor-kit/program-v2`.
2. **Swap** the stablecoin USDC → **EURC** (`Hzwqb…DKtr`, legacy SPL Token).
3. **Deploy** under our **own** program ID with **immutable / timelock**
   upgrade authority (do *not* depend on LazorKit's shared mainnet slot).
4. Stand up our **own CF-Worker Ed25519 fee-payer relay** (validate-then-sign,
   KV rate-limit, no fund authority) — mirroring the existing Gnosis relay.

---

## 5. Implementation phases (when/if greenlit)

| Phase | Goal | Deliverable |
|---|---|---|
| **0 — De-risk spike (devnet)** | Prove relayer-as-sole-Ed25519-signer + passkey-P256-as-instruction-data end-to-end. Confirm feature gate active; build minimal CF Worker that signs a tx with a precompile ix + trivial program ix; validate the WebAuthn encoding pipeline (DER→raw, low-S, COSE→compressed) on **real iOS Safari + Android Chrome**; measure CU + byte budget. | A devnet tx where a passkey P-256 assertion is verified on-chain and the relayer is the only Ed25519 signer; documented CU/byte budget. |
| **1 — Fork + deploy LazorKit, swap to EURC** | Read `auth/secp256r1.rs` to confirm the challenge binds to the *actual* tx; read the Accretion audit; verified build (Ellipsis `solana-verifiable-build`); deploy devnet→mainnet under a fresh **immutable/timelock** program ID; wire EURC; check EURC `freezeAuthority`. | Our own mainnet smart-wallet program ID + verified build + audit-review note; EURC as the euro unit. |
| **2 — Create + receive** | WebAuthn create → COSE→compressed pubkey + rpIdHash → derive wallet+vault PDAs client-side (show counterfactual address). Backend stores only public info (reuse `otp.domovina.ai` phone binding w/ `PHONE_PEPPER`). Relayer lazily creates wallet + 145-byte authority record + vault EURC ATA (or defers to first inbound transfer). Receive observability via Helius webhook → DO (mirror Monerium webhook-race idempotency). | Create a passkey wallet + receive EURC at a counterfactual vault, relayer sponsoring all rent. |
| **3 — Send + relayer hardening** | Client builds + signs the LazorKit challenge; relayer builds `[ComputeBudget, secp256r1 ix, Execute ix]`, **validate-then-sign**, KV 5/day per credentialId, priority-fee cap, submit + poll `getSignatureStatuses` via DO. Implement deferred-2-tx / ALT path for sends >1232 B. **Negative test: relayer-only tx without a valid precompile must be rejected.** | Validated mainnet EURC send authorized solely by passkey, gas paid by relayer, relayer provably authority-less — the analogue of the 2026-05-22 Gnosis validated send. |
| **4 — Recovery + SEPA on-ramp** | `addAuthority` second passkey (threshold-1 redundancy, test across iCloud/Google sync). Integrate a 3rd-party SEPA→EURC on-ramp (Transak/MoonPay/Privy) delivering to the vault ATA (**replaces** the Monerium IBAN mint rail). Outbound "paid" webhook (mirror the `pinka.finance` seam). Re-confirm self-custody invariant end-to-end. | Multi-passkey recovery + a retail SEPA→EURC funding path; documented divergence from the Monerium IBAN rail. |

---

## 6. Blockers

**Hard:**
- **No pure-composition path.** Strict passkey-as-authority self-custody
  needs a custom on-chain program — Squads members are Ed25519-only and the
  program doesn't read the precompile. → *Fork the audited LazorKit program.*
- **Monerium EURe is not on Solana** (no roadmap); EUROe is wound down; Circle
  Mint is institutional. The frictionless IBAN-per-wallet mint UX does **not**
  port. → *Adopt EURC + a 3rd-party retail SEPA on-ramp; do not bridge EURe.*
- **A passkey can never sign a Solana tx envelope** (P-256 vs Ed25519). Every
  send requires a fee-payer relayer. → *Intended architecture, not a defect;
  reject the MPC alternative.*

**Soft:**
- **SPL ATA rent** (`0.00203928 SOL`) before receipt — relayer sponsors via
  `createAssociatedTokenAccountIdempotent` (reclaimable on close; ~$0.31/user,
  the dominant per-user cost vs ~$0.0008/sig).
- **1232-byte tx cap** (LazorKit reports ~574 usable bytes per secp256r1
  Execute) can break a combined create+ATA+send batch — use **ALTs** and/or
  LazorKit's **deferred 2-tx** execution (the MultiSend-deploy+send analogue).
- **Upgrade authority = custody hole** even with a fee-payer-only relayer; and
  LazorKit shares its mainnet slot with commercial `lazorkit-protocol` via
  binary swap. → *Deploy our own immutable/timelock fork.*
- **WebAuthn malleability:** Apple/Android may return high-S + DER; the
  precompile rejects high-S. → *DER→raw, low-S normalize (use
  `SECP256R1_HALF_ORDER`), 33-byte compress, validated on real devices.*
- **LazorKit bus-factor:** small team, low traction, single audit firm. →
  *Fork-and-self-maintain the MIT program; immutability decouples our users'
  fund safety from their team's continuity.*

---

## 7. Reusable components

| Component | URL | Use |
|---|---|---|
| **lazor-kit/program-v2** | https://github.com/lazor-kit/program-v2 | **PRIMARY fork target — the Safe-equivalent.** Pillars 1,2,4,6 out of the box; swap USDC→EURC. |
| secp256r1 precompile spec (SIMD-0075) | https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0075-precompile-for-secp256r1-sigverify.md | The RIP-7212 analogue. Instruction/offset layout, 33-byte compressed pubkey, 64-byte raw `r‖s`, low-S enforcement. |
| `solana-secp256r1-program` (Rust crate v3.0.0) | https://docs.rs/solana-secp256r1-program/ | Client/relayer: `new_secp256r1_instruction_with_signature`, `SECP256R1_HALF_ORDER` low-S, offset structs. |
| Blueshift secp256r1 course (Anchor + Pinocchio) | https://learn.blueshift.gg/en/courses/secp256r1-on-solana/secp256r1-with-pinocchio | Reference for Instructions-sysvar introspection binding; `pinocchio-secp256r1-instruction` (Dean Little). Use to audit LazorKit's path. |
| anza-xyz/octane | https://github.com/anza-xyz/octane | **DESIGN reference only (archived).** Validate-then-sign relayer discipline. |
| Circle EURC on Solana | https://developers.circle.com/stablecoins/docs/eurc-on-main-networks | The euro unit. Mint `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr`, 6 dp, legacy SPL Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. |
| Squads-Protocol/v4 | https://github.com/Squads-Protocol/v4 | **SECONDARY / future** — M-of-N quorum option only (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`). |
| Squads/smart-account-program | https://github.com/Squads-Protocol/smart-account-program | **Track** — rent-free counterfactual + policies + roadmapped passkey member (`SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG`). |
| `@solana/kit` + `nodejs_compat` on CF Workers | https://developers.cloudflare.com/workers/runtime-apis/nodejs/ | Relayer runtime. `compatibility_date ≥ 2024-09-23`; fee-payer keypair in a Worker secret; external RPC (Helius/Triton); pair with a DO for polling. |

---

## 8. Open questions (highest-priority first)

1. **Does LazorKit bind the WebAuthn challenge to the *actual* Solana tx**
   (challenge == recomputed instruction/payer/slot/counter/program_id digest)
   or to a simpler app-defined message? Read `auth/secp256r1.rs` before
   trusting anti-replay-across-relay. **#1 code review.**
2. Exact **CU cost** of one precompile verify on mainnet, and whether a
   deploy+create-ATA+send batch fits 1232 B or mandates ALT / deferred-2-tx.
3. Does **EURC's mint have an active `freezeAuthority`** (issuer can freeze
   ATAs)? Affects the self-custody guarantee vs EURe on Gnosis.
4. LazorKit **upgrade authority / mutability** + the shared-mainnet-slot
   binary-swap arrangement — confirm we can deploy an independent immutable
   fork.
5. Which **3rd-party SEPA→EURC on-ramp** delivers EURC directly to a
   self-custody vault ATA with acceptable KYC/fees (Circle Mint is
   institutional-only; Monerium's IBAN rail does not exist on Solana).
6. Does LazorKit **`addAuthority` support a pure multi-passkey-owner (no
   quorum) flow** that survives iCloud/Google passkey-sync edge cases,
   matching `addOwnerWithThreshold` redundancy?
7. **CF Worker CPU/duration limits** vs the full relayer flow — confirm
   whether confirmation polling needs a Durable Object (likely).
8. Scope/findings of the **Accretion Labs audit** before any production
   reliance.

---

## 9. Provenance

Research method: autonomous multi-agent workflow (`Workflow` tool) — 6
parallel research agents (Squads v4, secp256r1/passkeys, fee-payer relay,
euro stablecoin, existing implementations, account-model mapping) →  4
adversarial verifiers (precompile mainnet status, Squads threshold-1/
counterfactual/add-member, euro stablecoin reality, relayer-as-sole-signer) →
1 synthesis agent. ~696k subagent tokens, 155 tool calls. Sources are primary
where possible (Solana docs, SIMD repo, Squads/LazorKit GitHub, Circle docs,
Monerium docs, Solana Explorer feature-gates). Every load-bearing claim
carries a source URL + recency in the raw dossier; key claims were
adversarially fact-checked.

**Verification verdicts:**
- secp256r1 precompile live on mainnet → **confirmed** (epoch 800, slot
  345,600,000; note: SIMD-**0075**, not 0048 which was withdrawn).
- Squads v4 threshold-1 + counterfactual vault + add-member → **confirmed**
  (verified against program source `multisig.rs` `invariant()`: no min-2 rule;
  `pda.ts`; `multisig_config.rs`). *Caveat: receive flow must use
  `getVaultPda(index)`, never the multisig config PDA, or funds may be
  unrecoverable.*
- Production euro stablecoin on Solana + SEPA on-ramp → **partial** (EURC ✅;
  EUROe dead; Monerium EURe not on Solana; Circle Mint institutional-only).
- Relayer as sole Ed25519 signer w/ passkey-only authority → **partial**
  (achievable via the smart-wallet/PDA pattern only; the MPC pattern that
  avoids custom Rust is custodial and rejected; mature audited gasless passkey
  stacks are still early).
