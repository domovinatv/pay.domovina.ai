# Building MPT with Claude Code — a real case study

_Captured: 2026-05-21. Document is dual-purpose: (1) an engineering
reference for developers exploring how to use Claude Code on serious
production work; (2) source material for a blog post + LinkedIn link
back to this public repo. Everything in this doc is traceable to
specific commits, files, on-chain transactions, and Monerium webhook
events in the repo and on Gnosis chain._

## What got built in one focused session

**MPT — Mint Pay Transfer** (mpt.hr) is a Croatian payment rail that
turns a SEPA bank transfer into routed EURe (Monerium's MiCA-compliant
EUR stablecoin) on Gnosis chain. The architecture:

```
[ Buyer (Revolut, any SEPA bank) ]
   │ €X transfer to LHV IBAN EE7077770001629211 28
   ▼
[ Monerium ] mints X EURe to MPT main-rail Safe multisig 0x449aBCEf...
   │ webhook to monerium.domovina.ai
   ▼
[ MPT backend (Cloudflare Worker) ] parses memo `mpt:<target>?sid=<id>`
   │ submits Roles.execTransactionWithRole(EURe.transfer(target, X))
   ▼
[ Zodiac Roles Modifier (audited) ] verifies role scope
   │ Safe executes transfer
   ▼
[ Target wallet on Gnosis ] receives X EURe — full on-chain audit trail
```

Around this rail, the session also produced:

- A branded buyer-facing checkout page at `mpt.domovina.ai/checkout/<sid>`
  with realtime status polling, success modal with audio chime, EPC QR
  rendered server-side as inline SVG.
- An operator admin dashboard at `mpt.domovina.ai/admin/` with four tabs
  (Webhook events, Monerium orders, Safe forwards, Payment intents) +
  realtime snackbar notifications + a "New intent" form modal.
- A reproducible governance system in `backend/safe-tx/` where every
  Safe multisig operation is a CLI-generated, audit-trailed batch.
- Five architecture / product-vision docs in `docs/` capturing
  decisions, risk mitigations, competitor analysis, and future
  implementation phases.
- A growing memory layer at `~/.claude/projects/.../memory/` capturing
  empirical findings (Monerium exact-match routing, SEPA `=`→`.` mapping,
  CowSwap auto-unwrap to native xDAI, SSE-needs-DO on Cloudflare).

Real money flowed: two test SEPA payments of €1.01 and €1.02 were
issued from Revolut, processed by Monerium, minted to the Safe,
forwarded on-chain, and recorded in the admin dashboard.

## Session by the numbers

- **Files committed**: 30+ source files, 5 design docs, 4 generator
  scripts, 4 EXECUTED audit MDs, 7 memory facts
- **Lines added**: ~5,500 (TypeScript + Dart + SQL + Markdown +
  shell)
- **Commits to main / feature branches**: 11 semantic commits
- **Production deploys**: 8 backend redeploys, 5 Flutter web deploys
- **On-chain transactions**: 1 Safe role-setup batch
  (`0xddb5da4d...`), 1 CowSwap settlement (`0xc892e368...`), 1 manual
  xDAI fund (Safe nonce 3→4), 1 EURe forward TX, 2 Monerium mint TXes
- **Webhook events processed**: 9, all signature-verified, all
  audited in D1
- **Monerium API calls**: 2 webhook subscriptions registered (old
  ngrok ones disabled), several `/auth/token` cycles
- **Subagents spawned**: 2 (PayCek competitive research, Shopify +
  WooCommerce gateway research) — both ran in background while main
  thread continued other work
- **External services touched**: Cloudflare (Workers, Pages, DNS, D1,
  KV, Secrets), Monerium API, LHV (via Monerium), Gnosis RPC, Safe
  multisig, Zodiac Roles Modifier, CowSwap, Gnosisscan, npm registry,
  GitHub

## How Claude Code actually works — the mental model

Claude Code is **not a chatbot wrapping an LLM**. It's an interactive
agent that can:

- **Read** any file in the project tree (and any path on disk if
  permitted)
- **Edit** files surgically (line-by-line diffs, not whole-file
  rewrites)
- **Write** new files
- **Run** shell commands and observe the output
- **Search** with `grep`, `find`, repo-aware tools
- **Spawn subagents** to parallelize research or isolate context
- **Maintain persistent memory** between sessions via the
  `~/.claude/projects/<repo-hash>/memory/` directory
- **Plan with TaskCreate** — visible progress markers the human can see

Critically, the loop is **collaborative, not autonomous**. You stay in
control of the keyboard. The agent suggests, executes, reports;
you correct, redirect, approve. Anything risky (force-push, deletion,
production secret upload) the agent confirms first or asks you to do
in a separate terminal.

### The memory system

The single most important Claude Code feature for serious projects.
It works like this:

1. Each project gets a `~/.claude/projects/<repo-hash>/memory/`
   directory containing curated facts as small Markdown files plus
   one `MEMORY.md` index.
2. The index is **auto-loaded** at the start of every new session.
3. Individual fact files are loaded on-demand when relevant.
4. Three types of facts:
   - **`reference_*.md`** — addresses, URLs, deploy commands, brand
     constants — the WHERE / WHAT
   - **`feedback_*.md`** — gotchas, rules learned the hard way — the
     "don't do this" patterns
   - **`project_*.md`** — current initiatives, deadlines — the WHEN /
     WHY
5. Memory grows over time. After enough sessions on a project, a new
   Claude Code session opens with all the institutional knowledge
   already in head — **without** having to re-read the chat history.

This session's memory grew from 12 facts to 14, adding:

- `feedback_monerium_webhook_race.md` — "trigger forwards on
  `order.updated` + `state=processed`, NEVER on `order.created`"
- `feedback_sse_workers_durable_objects.md` — "SSE on plain CF Workers
  cannot push across instances; use Durable Object"
- `feedback_cowswap_eure_xdai_gnosis.md` — "CowSwap delivers native
  xDAI (`0xEEee...EeeE` buyToken), not wxDAI"

Each of these started as a "huh, that didn't work" moment in the
session and got converted to durable knowledge. Future sessions on
this project literally cannot repeat these mistakes.

### TaskList for multi-step work

When the agent commits to a multi-step plan, it writes the steps as
`TaskCreate` items the user sees in the UI. Tasks transition `pending
→ in_progress → completed`. This means:

- The human sees the plan **before** execution starts
- Mid-flight the human knows exactly what's done vs pending
- If interrupted, the next session can pick up from the task list

In this session, ~40 tasks were created across phases. None lost
state.

### Subagents

When research is broad or independent of the current critical path,
the main agent spawns a subagent that runs in a fresh context. The
subagent has its own tool budget, returns a summary, and the main
agent continues. Two examples this session:

- **PayCek competitive research** — 30 tool uses, 240s duration,
  produced `docs/competitor-analysis/paycek-electrocoin.md` (1,500
  words, cited primary sources)
- **Shopify + WooCommerce integration research** — 30 tool uses, 274s
  duration, produced `docs/integrations/shopify-woocommerce-gateway.md`
  (2,500 words with effort estimates per integration tier)

Both ran in the **background** while the main thread continued
implementation work on the intent flow.

## Five patterns that made this productive

### 1. Spec-driven, doc-as-source-of-truth

Before implementing a feature, the agent writes a design doc:

- `docs/product-vision/payment-intents-and-sse.md` — full spec for
  intent flow + SSE upgrade path (written first; implementation
  followed)
- `docs/product-vision/per-event-safe-rail.md` — captured a customer
  insight ("each event gets its own Safe") into a multi-phase plan
  before any code was touched
- `docs/integrations/shopify-woocommerce-gateway.md` — researched
  integration paths and effort estimates before committing to a tier

The docs survive context resets. Anyone reading the repo two months
later sees not just the code, but **why** the code is shaped the way
it is.

### 2. Reproducible governance via `safe-tx/`

Every multisig operation on the MPT Safe lives in
`backend/safe-tx/<NNN>-<name>.{mjs,template.json,EXECUTED.md}`:

- **`.mjs`** is a Node script that takes CLI flags and emits a Safe
  Transaction Builder JSON
- **`.template.json`** is the canonical output with sentinel
  placeholders (no real EOA addresses) — committed for review
- **`.EXECUTED.json`** is the patched version that was actually
  uploaded to Safe — committed for audit
- **`.EXECUTED.md`** records the on-chain TX hash, block number,
  signer info — committed for traceability

This pattern means **anyone can regenerate any Safe operation
byte-for-byte** and verify it against on-chain state. No trust-the-dev
moments.

Three batches shipped this session:

- `001-eure-forwarder-role-setup` — created the EUReForwarder role on
  the Zodiac Roles Modifier, scoped to ONLY `EURe.transfer`,
  registered backend EOA as member
- `002-fund-router-eoa` — refueled backend EOA with xDAI for gas
- `003-manual-forward` — orphan-recovery generator (parameterizable
  for any future stuck-payment scenario)

### 3. Empirical-first, never speculate

When in doubt about on-chain state, the agent queried Gnosis RPC
directly with `curl` + `eth_call`. Examples from this session:

- Verified the Safe's owner list, threshold, and version before
  trusting it as the deploy target
- Verified the Zodiac Roles Modifier's `owner()` was the Safe before
  trusting the security model
- Confirmed CowSwap order fulfillment by querying the CowSwap API
  directly
- Reproduced the webhook race condition by simulating the failing TX
  with `eth_call` and decoding the custom error selector
  `0xd27b44a9` against a list of candidate Modifier errors

The agent never relied on training-data assumptions about contract
ABIs or chain state. Every claim was either re-verified or marked
explicitly as uncertain.

### 4. Background subagents = parallel work

The main thread doesn't need to wait for research to finish. While
the PayCek research subagent ran in the background, the main thread
finished webhook handler bug fixes and Flutter EIP-55 implementation.
Result delivered when ready, no blocking.

### 5. Audit-trail-shaped commits

Every commit has a verbose semantic message that captures:

- **What changed** (file list, code-level)
- **Why** (the WHY — bug, design intent, customer constraint)
- **What was verified** (smoke test results, on-chain TX hashes)
- **Trade-offs** (this rejected, that deferred to Phase N)

Example:

```
fix(mpt): forward race + EIP-55 typo defense + risk catalogue

Backend (production bug fix):
- Webhook handler was triggering forward on `order.created`
  (state=pending), before Monerium's mint TX reached chain — Safe
  had no EURe to transfer, causing `ModuleTransactionFailed()` at
  the inner ERC-20 call. Switched trigger to `order.updated` with
  `state=processed`, which is the signal that `meta.txHashes` is
  populated and the Safe balance is live.
- Added `maybeForward` wrapper with idempotency check against the
  latest forward row for the same order_id...
```

`git log --oneline` is now a readable timeline of architectural
decisions, not a wall of "fix bug" messages.

## What needed iteration

Honest section. Things didn't always go smoothly the first try.

### The webhook race condition

The first implementation triggered forwards on `order.created`. Real
production test surfaced the bug: Monerium mints AFTER it
acknowledges receipt, so the Safe had no EURe to forward at trigger
time. Forward attempted, on-chain TX reverted with
`ModuleTransactionFailed()`. EURe stayed parked in Safe (safe outcome
— funds not lost, just stuck pending manual settlement).

Fix took ~30 minutes:
- Diagnosis (selector lookup, on-chain query, payload inspection)
- Code change (trigger on `order.updated` + `state=processed` +
  idempotency check)
- Generator script for orphan recovery (`003-manual-forward.mjs`)
- Memory entry to prevent future Claude from re-introducing the bug
- Deploy + commit

### Broken inline JS QR library

The agent's first attempt at the checkout page bundled a
heavily-trimmed JS QR encoder inline. It would not have worked in a
browser — the trimmed lib was missing several internal functions.
Caught by inspection ("this is too dense to be correct"), refactored
to server-side SVG generation via the `qrcode-generator` npm package.
Cleaner result anyway: no client-side JS needed for the QR display.

### Wrangler cwd issues

Multiple times the agent ran `wrangler` commands from the repo root
instead of `backend/`, causing wrangler to either fail or
misinterpret as a static-assets deploy. Each time the user pointed it
out, the agent learned to `cd /backend` explicitly.

### Three rounds of EIP-55 implementation

First attempt: vendor a minimal Keccak-256 implementation by hand.
Rejected — too much risk for crypto code.

Second attempt: depend on `pointycastle`. Pubspec edit failed due to
Read-before-Edit policy. Re-read pubspec, edit succeeded.

Third attempt: write the validator + test cases against EIP-55
official test vectors. All passed first try.

Net: ~15 minutes for what could have been 2 minutes if the agent had
gone straight to "use pointycastle, write tests."

## The security model — how private keys stayed safe

Real money was involved. Several private keys + secrets had to move
into Cloudflare Workers secrets without ever entering Claude's
context. Patterns used:

- **`.dev.vars`** local file (gitignored) holds production secrets
  for local dev parity
- **`awk` extract + `printf` pipe to `wrangler secret put`** — the
  agent runs a script that reads the secret value from `.dev.vars`,
  pipes it through `printf '%s'` (no newline, no echo) into
  `wrangler secret put` over CF API. The value never lands in shell
  output, never reaches Claude.
- **Backend EOA private key generation by the user in a separate
  offline terminal** — the agent provided a documented Bash script
  (`safe-tx/000-generate-backend-eoa.sh`) that the user ran in their
  own terminal. Claude saw the public address only; the private key
  went directly to user's 1Password and then `wrangler secret put`
  from the same offline terminal.
- **Safe multisig signing requires 2-of-3 human signers via Safe
  Mobile / Safe Web** — Claude can prepare and propose, never sign.
- **Smart contract deployment requires user authorization** — Claude
  can write Solidity, never broadcast deploy TXes.

What Claude DID see in its context:
- One disposable test private key (smoke-test-only, immediately
  overwritten by user's real key — explicitly marked test)
- One generated admin Basic Auth password (user saved to 1Password
  immediately; could rotate at will)

What Claude NEVER saw:
- The backend EOA private key
- Monerium client secret / webhook secret
- Enable Banking PEM key
- Safe owner seed phrases
- Cloudflare account API tokens

## The cost vs value math

Context usage at session end: ~497k tokens / 1M limit (50%). One
operator (me) drove the session over a stretch of several hours of
focused work. Realistic comparison points:

- **Equivalent traditional dev time**: a single senior full-stack
  engineer with knowledge of CF Workers + Solidity + Monerium APIs
  + Safe SDK + Flutter Dart would take an estimated 1-2 weeks for
  the same scope (backend + frontend + intent + checkout + admin +
  docs + safe governance + Monerium integration + Zodiac role
  setup + on-chain forward + test infrastructure).
- **API token cost for the session**: order of $30-80 USD depending
  on cache hit rates, well-known model pricing.
- **Value of curated docs + memory artifacts**: hard to price, but
  these compound — every future session opens with them already in
  scope, accelerating subsequent work.

The economic argument is overwhelming when the agent is treated as a
**force multiplier on a specialist developer** rather than a
replacement. The operator still needs to make every key decision
(which Safe model, which DEX, when to deploy, when to wait for legal
review). The agent handles the typing, the lookup, the audit-trail
writing, the test scaffolding — all the high-overhead work that a
human would do slowly and tire of doing thoroughly.

## What Claude Code can't do (real limits)

Not magical. The session repeatedly hit limits and worked around
them:

- **Cannot sign Safe multisig transactions** — humans must approve
  via Safe Mobile / Safe Web. Agent only prepares the calldata +
  batches.
- **Cannot generate or hold sensitive private keys** by design —
  user generates in their own terminal, agent never sees the value.
- **Cannot upload to a regulatory body** (Hanfa, EBA, etc.) — agent
  can draft the application but a human submits it.
- **Cannot deploy smart contracts to mainnet without explicit
  authorization** — the agent can write Solidity, simulate, suggest
  deploy commands; the user runs them.
- **Cannot guarantee correctness of external API responses** — when
  Monerium changes a webhook field shape, the agent will only catch
  it on the next live event. Empirical verification is required.
- **Cannot autonomously decide product strategy** — when the user
  asked about positioning ("Marko Perković Thompson coincidence
  with MPT initials"), the agent surfaced trade-offs (regulatory
  risk, Monerium compliance review impact) but the user chose the
  positioning.
- **Cannot perform legal counsel duties** — multiple times the agent
  explicitly flagged "needs lawyer sign-off" (CASP licence under
  MiCA, KYC obligations for per-event Safe model, etc.).

## What's in the repo for future readers

If you're reading this in a year and want to retrace the architecture
+ decisions, start here:

- **[`docs/product-vision/per-event-safe-rail.md`](../product-vision/per-event-safe-rail.md)** — the
  bigger picture vision
- **[`docs/product-vision/payment-intents-and-sse.md`](../product-vision/payment-intents-and-sse.md)** —
  the realtime checkout spec + SSE/DO design
- **[`docs/integrations/shopify-woocommerce-gateway.md`](../integrations/shopify-woocommerce-gateway.md)** —
  webshop integration paths + effort estimates
- **[`docs/competitor-analysis/paycek-electrocoin.md`](../competitor-analysis/paycek-electrocoin.md)** —
  competitor benchmark
- **[`backend/safe-tx/README.md`](../../backend/safe-tx/README.md)** —
  the governance pattern + reproduction instructions
- **[`backend/safe-tx/PHASE-2-SAFE-API.md`](../../backend/safe-tx/PHASE-2-SAFE-API.md)** —
  next-iteration multisig propose-and-sign design
- **[`backend/safe-tx/RISK-MITIGATIONS.md`](../../backend/safe-tx/RISK-MITIGATIONS.md)** —
  catalogue of every defense considered against routing-target typos
- **`git log --oneline`** — semantic timeline of decisions

The full source code is intentionally readable: every non-obvious
function has a JSDoc explaining the WHY, not just the WHAT.

## How to start using this approach on your own project

1. **Install Claude Code** — `claude.ai/code` for CLI, web app, IDE
   extensions
2. **Open your project** — Claude Code respects your existing
   structure
3. **Start small** — give it a real task ("add /healthcheck endpoint
   that pings the DB") and see how it works
4. **Build the memory layer deliberately** — when something
   non-obvious happens (a bug, a gotcha, a convention), ask Claude
   to "remember" it. Over months this becomes priceless.
5. **Write docs into the repo** — treat design docs as
   first-class artifacts. Claude reads them on demand and they
   survive context resets.
6. **Trust but verify** — read the diffs before committing,
   especially for security-sensitive changes. The agent is honest
   when uncertain; respect those flags.
7. **Use subagents for research** — long competitive analyses, doc
   ingestion, multi-page web research belong in background tasks,
   not the main thread.
8. **Commit frequently with semantic messages** — every commit is
   a checkpoint in case you want to roll back or reference the
   change later.

## Closing

MPT is live at https://mpt.domovina.ai. The Safe multisig is
[`0x449aBCEf...`](https://gnosisscan.io/address/0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e)
on Gnosis chain. The first two test payments (1.01 EUR + 1.02 EUR)
are visible in the on-chain history, alongside the role-setup batch
and CowSwap settlement. The admin dashboard (Basic Auth gated)
records every webhook event, every order, every forward, every
intent.

Everything in this repo is real, reproducible, and currently
deployed. If you're building a fintech or stablecoin product in
Croatia or the EU and want to compare notes, the repo is public.

---

**Open-source repo**: https://github.com/domovinatv/pay.domovina.ai
(branch `feat/payment-registry-onchain` has the latest, including
intent flow + on-chain PaymentRegistry contract work in progress)

**Live product**: https://mpt.domovina.ai

**Related domains**: pay.domovina.ai (existing Flutter QR
generator), donate.domovina.ai (sister donation site),
otp.domovina.ai (SMS verification — the architectural pattern that
inspired MPT's payment intent flow)
