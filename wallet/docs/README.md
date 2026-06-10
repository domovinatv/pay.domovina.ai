# DOMOVINA Wallet — docs

Durable design knowledge for this repo. Read these before touching connect/onboarding
/ deploy — the obvious approaches mostly fail in non-obvious ways and these capture why.

- **[user-flows.md](./user-flows.md)** — combinatorially complete map of every user path
  (happy + dead-end) across every route and state machine, with 12 mermaid diagrams. Plus
  the **duplicate-passkey root-cause + phased fix plan** (the "two domovina-wallet-v1 in
  Apple Passwords" bug). Start here for a bird's-eye of the whole app.
- **[passkey-onboarding-industry-standards.md](./passkey-onboarding-industry-standards.md)** —
  research-backed reference: how Coinbase Smart Wallet (open-source contracts; **closed**
  frontend) actually handles passkeys, why it does NOT solve duplicates better than us, and
  the W3C/Chrome standard (conditional mediation + Signal API). The authoritative, revised
  duplicate-passkey fix plan. Validates our 1-of-2 recovery model against Coinbase's.
- **[cross-origin-wallet-connect.md](./cross-origin-wallet-connect.md)** — how a passkey
  wallet on `wallet.domovina.ai` is connected by dApps on other domains (e.g. pinka.io).
  Why NOT iframe, why NOT in-page RoR, why a deterministic full-page redirect + cached
  identity; the `dw_*` return contract + CSRF; the send() iframe path. Sequence diagrams.
- **[passkey-onboarding.md](./passkey-onboarding.md)** — the create/open state machine and
  the five hard-won rules (never get-first before create; excludeCredentials not stable
  user.id; OS-sheet-title tells you the ceremony; etc.). State diagram.
- **[deploy-and-pwa.md](./deploy-and-pwa.md)** — deploy command + the service-worker
  staleness / MIME-error traps that repeatedly looked like "my fix didn't ship".
- **[security-custody-model.md](./security-custody-model.md)** — the headline promise:
  auto cross-device sync, but no one (operator, DB breach, Cloudflare) can move funds
  without your Face ID / seed. What the server holds (only public data) vs. what it
  never does (keys/seed); why a full DB dump can't steal; "no secrets" vs "encrypted
  secrets"; the 1-of-2 recovery model; honest privacy caveats. 4 mermaid diagrams. The
  value-prop security doc.
- **[relayer-threat-model.md](./relayer-threat-model.md)** — what the gas-sponsoring
  relayer can/can't do (custody invariant vs. xDAI-drain threat), why payloads are
  offline-forgeable, the layered abuse defenses (per-signer / per-IP / global budget /
  Turnstile), the KV-atomicity residual, and the `/embed` origin-trust rule. Flow +
  sequence diagrams.
- **[relayer-architecture.md](./relayer-architecture.md)** — the shared `functions/_lib`
  module (single source of CREATE2 truth) and why drift strands funds; the hot-vs-cold
  send decision flow; request lifecycle; editing rules. Module + flow diagrams.
- **[safe-upstream-reference.md](./safe-upstream-reference.md)** — the local sibling
  clone of Safe's official `safe-wallet-monorepo` (app.safe.global + Safe Mobile) we
  copy audited patterns from: where it lives, why a clone not a submodule, how to sync,
  the copy-with-provenance workflow, and the GPL-3.0/trademark caveats.
- **[STAGING.md](./STAGING.md)** — staging environment notes.

Open follow-ups (backend/architectural) live in the agent memory `wallet-audit-followups`.
