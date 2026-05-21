# MPT routing risk mitigations — catalogue & status

Background reading: in the current MPT architecture, a typo in the EPC QR
target address causes irreversible loss because the backend auto-forwards
EURe from the Safe to whatever address it parses out of the memo. Once
on-chain, ERC-20 `transfer(wrongAddress, x)` cannot be undone. This file
catalogues every mitigation we considered, with current status, rationale,
and a sketch of what implementation would look like.

Goal: nothing decided here is forgotten. When we revisit security posture
(quarterly review, audit, growth milestone, near-miss event), this file is
the single index.

---

## ✅ Implemented (production)

### 1a. EIP-55 mixed-case checksum validation (frontend)

**Status:** Live as of 2026-05-21. See `lib/utils/eip55.dart` +
`lib/ui/home_page.dart` field validation. Test coverage in
`test/eip55_test.dart` (6 cases including official EIP-55 vectors + a
single-character typo on the MPT Safe address).

**What it catches:** ~99% of single-character typos and copy-paste
corruption, when the user pastes a mixed-case address from MetaMask /
Rabby / Etherscan / Safe UI. The keccak-256 of the lowercase address
deterministically casts each non-digit hex char's case; a single nibble
flip almost always violates at least one case bit and trips the check.

**What it does NOT catch:** addresses pasted as all-lowercase (no
checksum claim). These pass validation with a "no typo protection"
warning shown to the user. Wallets sometimes emit lowercase (e.g.
Monerium's API), so we cannot reject lowercase outright.

**Companion check:** `_addressHelperText()` shows the EIP-55 checksum
form of any bad-checksum input ("Predloženo: 0xCorrected..."), letting
the user spot the difference and likely the typo location.

### 1b. Explicit confirmation checkbox before QR reveal (frontend)

**Status:** Live as of 2026-05-21. See `_buildConfirmTargetBanner()` +
`_unconfirmedPlaceholder()` in `home_page.dart`.

**What it does:** Until the user ticks the "Potvrđujem da je target
adresa točna" checkbox, all 3 QR preview cards are replaced by a locked
placeholder. The QR cannot be screenshotted, downloaded, or scanned in
that state. Bilo kakva promjena address polja auto-resetira checkbox,
forsirajući re-confirm.

**What it catches:** the "muscle-memory scan" failure mode where a user
glances at the address field, paste-overrides without reading, and scans
immediately. The mandatory tick is a deliberate stop sign in the flow.

**What it does NOT catch:** users who tick without reading. Behavioural
mitigations are imperfect.

### 1c. Role-scoping to EURe.transfer only (on-chain, Zodiac Roles)

**Status:** Live since 2026-05-21 batch 001 execution. See
`001-eure-forwarder-role-setup.EXECUTED.md`.

**What it catches:** compromised backend EOA can ONLY call
`EURe.transfer(any, any)` via the Safe. Any other ERC-20, any other
function (approve, burnFrom, transferFrom), or DelegateCall — all revert
at the Modifier layer. Other Safe assets (xDAI, future tokens) are
out-of-scope and inaccessible to the role.

**What it does NOT catch:** target-address typos in legitimate forwards.
The role permits "any address" as recipient because it has to —
restricting recipients to an allowlist would require pre-registering
every customer wallet, which doesn't match MPT's intended UX. See 2c below.

---

## ⏳ Planned (designed, not yet implemented)

### 2a. Per-recipient anomaly detection

**Status:** Designed in [PHASE-2-SAFE-API.md](./PHASE-2-SAFE-API.md). Not implemented.

**Idea:** Backend keeps history of all forwarded-to addresses in a D1
table. When a new Monerium order arrives with a routing target the
backend has never seen before (or hasn't seen in N days), AND the amount
exceeds threshold X, do NOT auto-forward — instead, escalate to Safe
Transaction Service propose path so signers see the proposal in Safe
Mobile and explicitly approve before EURe moves.

**Cost vs benefit:** moderate implementation cost (new D1 table, two
extra lookups in webhook handler, dependency on Safe API integration
from Phase 2). Big benefit for legitimate enterprise customers (first
payment to a new vendor triggers human review; subsequent payments to
same vendor auto-forward). Probably the next mitigation worth shipping
once MPT has > €100/day flow.

### 2b. Amount cap baked into the on-chain Roles scope

**Status:** Designed. Not implemented.

**Idea:** Today the role's `scopeFunction(transfer, ...)` has Parameter
conditions = `Any/Any`. We could narrow it to `amount <= N EURe wei` by
configuring a ParameterCondition on the second argument of `transfer`.
At runtime, any backend forward attempt for > N EURe reverts AT THE
MODIFIER LAYER — backend cannot bypass even if its key is stolen.

**Implementation:** new batch `003-add-amount-cap-to-role.mjs` in
this directory. Calls `Roles.unscopeParameter` then
`Roles.scopeFunction(...)` with `ParameterCondition[]` carrying a
`Comparison.LessThanOrEqualTo` on the amount slot. One Safe TX, no
backend code change required.

**Cost vs benefit:** ~30min implementation. Strong on-chain guarantee.
Trade-off: any legitimate large forward (e.g. €5000 vendor payout) now
requires either re-scoping the role temporarily (Safe TX) or routing
through Phase 2 Safe API propose. Probably waits until 2a is in place
so the dispatcher cleanly routes large forwards away from Roles.

### 2c. Backend-side recipient allowlist

**Status:** Discussed. Currently rejected for general use.

**Idea:** D1 table `mpt_routing_allowlist(address, label, ...)`. Webhook
handler refuses to forward unless target is in allowlist; instead
records as `pending_review` and EURe stays parked in Safe.

**Why rejected (for now):** misfits the MPT UX which expects to support
arbitrary one-off donation/payment use cases. Pre-registering every
recipient adds friction that wipes out the "pay with one QR" pitch.

**Future use case:** could be enabled selectively for "managed account"
MPT customers (e.g. an org with 3 payout wallets that wants stronger
guarantees) via a per-account flag. Not part of the core product.

### 2d. Phase 2 Safe API multisig propose for high-value forwards

**Status:** Designed in [PHASE-2-SAFE-API.md](./PHASE-2-SAFE-API.md). Not implemented.

**Idea:** Forwards above policy threshold use `safe-api-kit` to propose a
Safe TX to the Transaction Service; signers see it in Safe Mobile,
biometric-sign, and only then EURe moves. Phase 2 doc covers the full
architecture including proposer-as-delegate pattern, policy thresholds,
mobile UX, race conditions.

---

## 🔁 Reactive (no automation; documented for completeness)

### 3a. Monerium EMI escalation for genuine errors

**Status:** Documented. No automation.

**Idea:** Monerium is an EU-licensed Electronic Money Institution (LHV
banking partner in Estonia). If a typo results in EURe going to an
address that is identifiable as a real customer of Monerium, support can
sometimes negotiate return. If the address is an unidentified third
party, Monerium has compliance powers (freeze EURe at the issuer level
via the contract's admin functions) which can prevent further movement
but does not return funds.

**Limitations:** Slow (days to weeks). Not a contractual obligation.
Reputational cost on MPT side for repeat occurrences. Only applies to
EURe — wxDAI, native xDAI, other tokens are out of Monerium's control.

**When to use:** absolute last resort after a real-money typo where the
recipient is identifiable. Do not rely on this as a security control.

### 3b. Multi-sig escrow contract with 24h timelock

**Status:** Discussed. Likely never implementing.

**Idea:** Deploy a custom contract that receives EURe from the Safe,
holds it for 24h, lets the user cancel/redirect during that window, then
auto-releases to the original target.

**Why probably never:** large implementation cost (Solidity, audit,
deploy, ongoing maintenance of the contract). Adds 24h latency to every
MPT payment, breaking the "instant settlement" UX promise. Covered by
2a + 2d at lower cost and complexity.

---

## Triggers for re-prioritization

This catalogue is a living document. The "Implemented" section should
grow as we ship 2a/2b/2d. Events that should trigger a re-read +
re-prioritization:

- **First real-money typo incident** — if it happens, ship 2a immediately
  regardless of order
- **Insurance / compliance partner asks** — typical audit questions like
  "how do you authorize large payouts" point at 2d
- **Volume crosses €10k/day** — 2b becomes effectively free insurance
- **New product surface** — adding USDC support, multi-recipient splits,
  or institutional accounts each warrant a fresh pass through this file
- **Annual security review** — quarterly or yearly cadence, schedule the
  review as a calendar item now

## Related

- [PHASE-2-SAFE-API.md](./PHASE-2-SAFE-API.md) — Safe Transaction Service propose-and-sign design
- [001-eure-forwarder-role-setup.EXECUTED.md](./001-eure-forwarder-role-setup.EXECUTED.md) — current on-chain Roles scope
- `lib/utils/eip55.dart` + `test/eip55_test.dart` — frontend typo defense implementation
