# Phase 2 — Safe Transaction Service integration for policy-tiered routing

**Status:** Design document only. Not implemented as of 2026-05-21.
**Owner:** Matija / ms-mpt-mr-signer
**Companion to:** Phase 1 (current production) — Zodiac Roles Modifier auto-forward

## Why this exists

Phase 1 routes EVERY incoming Monerium issue order through `Roles.execTransactionWithRole(EURe.transfer, ...)` instantly, signed by the backend EOA. Great UX for small/automated payments. Risk-flat for the operator: a compromised backend key can drain the Safe of EURe (mitigated by minimal accumulation, but still a non-zero blast radius).

Real-world MPT volume will mix payment sizes. A payout of €5,000 to a new wallet shouldn't share a security model with a €5 micro-payment. Phase 2 introduces a **policy ladder** that escalates from auto-execute → multisig-approve as amounts grow.

## Architecture

```
Monerium webhook arrives →
  parse memo (target, sid, amount) →
    [policy decision based on amount + target + sid history] →
        ↓                              ↓
   Phase 1 path                   Phase 2 path
   (auto-execute)              (Safe API propose)
        │                              │
   Roles Modifier                Safe Transaction Service
   execTransactionWithRole      proposeTransaction REST call
        │                              │
   Safe.transfer(target, amount)  signers see pending TX in Safe Mobile
        │                              │
   on-chain in ~10s              push notif → biometric Face ID approve
                                       │
                                  threshold sigs collected →
                                  anyone executes on-chain
```

## Suggested policy ladder (initial defaults — tune after observing real traffic)

| Forward amount | Mechanism | Auth requirement | UX latency |
|---|---|---|---|
| ≤ €100 | Phase 1: Roles auto-execute | None (backend key only, scoped) | ~10 sec |
| €100–€1000 | Phase 2: Safe API propose | 2 of 3 signers via Safe Mobile | ~5–15 min |
| > €1000 | Phase 2 + out-of-band alert | 2 of 3 signers + Telegram alert to ms-mpt-mr-signer | ~human response time |

Thresholds + per-recipient overrides should live in a D1 config table so they can be tuned without redeploying the Worker.

## Tech stack

Safe provides three npm packages designed to be used together:

| Package | Purpose |
|---|---|
| `@safe-global/protocol-kit` | Build Safe transactions off-chain, compute Safe TX hash, sign hashes locally. Works against any Safe regardless of where it was deployed. |
| `@safe-global/api-kit` | TypeScript wrapper for the Safe Transaction Service REST API. `proposeTransaction`, `confirmTransaction`, `getPendingTransactions`, etc. |
| `@safe-global/relay-kit` | (Optional) Gas relay so backend doesn't need xDAI. Probably skip for MPT — the backend already manages its own EOA + gas. |

Transaction Service public endpoint for Gnosis: `https://safe-transaction-gnosis-chain.safe.global/api/v1/`. Free, rate-limited (~30 req/min per IP for unauthenticated; higher with free API key). Self-hosting is possible but unnecessary at any realistic MPT volume.

## Proposer identity options (pick one)

1. **Backend EOA as Safe owner** — would require adding the EOA to the 3 existing owners (making it 2/4 or 1/4 — security loss). Not recommended.

2. **Backend EOA as Safe delegate** *(recommended)* — Safe Transaction Service has a separate "delegates" concept. A delegate can propose TXes on a Safe's behalf without being an owner. Added via API call (no on-chain TX needed). Revoked the same way. Backend's existing EOA `0xd61289c5...` is the natural choice — already trusted with Roles auto-forward, naturally extends to proposing higher-value TXes.

3. **Separate proposer EOA** — generate a third key just for proposing. More keys to manage, marginal security gain (since proposer can only fill the queue, not sign).

Decision: reuse current EOA as delegate. One key, two policy-gated authorities (Roles execute for small, STS propose for big).

## Implementation sketch (DO NOT WRITE CODE YET)

New file `backend/src/router/safe-api.ts`:

```typescript
// signature only — body deferred to implementation phase
export async function proposeViaSafeApi(env: Env, args: {
  target: Address;
  amountWei: bigint;
  sid: string | null;
  reason: 'amount_threshold' | 'recipient_new' | 'manual';
}): Promise<{ ok: boolean; safeTxHash?: Hex; error?: string }>;
```

Webhook handler extension (`src/index.ts`):

```typescript
// pseudocode — applies after routing target extraction
const policy = await evaluatePolicy(env, { target, amountCents, sid });
if (policy === 'auto')        await forwardViaSafe(env, ...);       // Phase 1
else if (policy === 'propose') await proposeViaSafeApi(env, ...);   // Phase 2
else if (policy === 'block')   await recordForBlocked(env, ...);    // future allowlist
```

D1 schema addition (`migrations/0007_routing_policy.sql`):
- `policy_thresholds` table (single row): `auto_max_cents`, `propose_max_cents`, `out_of_band_alert_cents`
- `policy_recipient_overrides` table: per-target custom rules (e.g. always-auto for known internal wallets, always-propose for never-seen ones)
- `pending_safe_proposals` table: linkage between Monerium order → Safe TX hash → final settlement

Admin UI extension: new tab "Pending proposals" showing queued Safe API TXes that haven't been signed yet, with direct links to Safe Mobile / Safe Web for signers.

## Operational concerns to think through before implementation

- **Race conditions** — if Monerium webhook fires multiple `order.updated` events for the same order, ensure idempotency. Phase 1 already handles via `monerium_processed_event_ids`. Phase 2 must additionally guard against double-proposing on retries (`pending_safe_proposals` row keyed by order_id).
- **Stale proposals** — if signers don't sign within N days, the pending TX sits in STS forever. Add cron job to alert ms-mpt-mr-signer when proposals age past 24h.
- **Nonce contention** — Safe TX nonces are sequential. If a Phase 2 propose creates nonce X but signers haven't executed, and meanwhile a Phase 1 Roles call uses... wait, Roles Modifier executes via Modifier's own pathway, which uses Modifier's nonce not Safe's. So no contention — Roles forwards and Safe API proposals don't share nonces. **Verify this when implementing** — read the Zodiac Modifier source.
- **Mobile signing UX** — install Safe Mobile (iOS/Android) on each signer's device pre-emptively, import their respective seed phrases, test that push notifications work. Sign-up friction is the main UX risk; cure with a "first proposal is a €0.01 demo" onboarding TX.
- **Reject path** — when signers disagree with a proposal (e.g. detected scam), they propose a 0-value TX with the same nonce to cancel. Make sure admin UI surfaces both proposed payouts AND rejection options clearly.
- **Audit** — Safe TX hashes + Phase 2 settlements should land in `monerium_forwards` table same as Phase 1, with `status` including `pending_signature`, `signed_partial_X_of_N`, `executed`, `rejected`. Single source of truth for "what happened to each Monerium order."

## Why not just use Safe API for everything

Phase 1 (Roles auto-execute) has irreplaceable properties for low-value flows:
- **Sub-10-second latency** — no human in the loop, no Safe Mobile push delays
- **Off-hours operation** — backend handles 3 AM Monerium events without waking anyone
- **Cheaper gas** — single TX via Modifier vs Safe API which is 1 propose + N signature submissions + 1 execute (more storage writes, more events)
- **No mobile dependency** — Safe Mobile having a bad day shouldn't block payment processing

Phase 2 layers on TOP of Phase 1 — selectively escalates only the subset of forwards that warrant the friction. Both stay live in production simultaneously, dispatched by the policy evaluator.

## When to implement

Triggers that should move Phase 2 from "documented" to "implemented":

- First MPT-routed payout > €100 happens in production
- Insurance / compliance partner asks "how do you authorize large payouts?"
- A near-miss on backend key safety (suspicious activity, key rotation event, etc)
- General security review milestone (annual?)

None of these have happened as of 2026-05-21. Phase 1 is sufficient for MVP and initial customer load.

## Related reading

- Safe Transaction Service API docs: https://docs.safe.global/core-api/transaction-service-overview
- Protocol Kit: https://docs.safe.global/sdk/protocol-kit
- API Kit: https://docs.safe.global/sdk/api-kit
- Delegates concept: https://docs.safe.global/core-api/transaction-service-guides/delegates
- Memory `reference-mpt-brand-and-routing-architecture` — Phase 1 implementation details
- `safe-tx/001-eure-forwarder-role-setup.EXECUTED.md` — current Roles configuration on-chain audit
