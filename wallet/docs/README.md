# DOMOVINA Wallet — docs

Durable design knowledge for this repo. Read these before touching connect/onboarding
/ deploy — the obvious approaches mostly fail in non-obvious ways and these capture why.

- **[cross-origin-wallet-connect.md](./cross-origin-wallet-connect.md)** — how a passkey
  wallet on `wallet.domovina.ai` is connected by dApps on other domains (e.g. pinka.io).
  Why NOT iframe, why NOT in-page RoR, why a deterministic full-page redirect + cached
  identity; the `dw_*` return contract + CSRF; the send() iframe path. Sequence diagrams.
- **[passkey-onboarding.md](./passkey-onboarding.md)** — the create/open state machine and
  the five hard-won rules (never get-first before create; excludeCredentials not stable
  user.id; OS-sheet-title tells you the ceremony; etc.). State diagram.
- **[deploy-and-pwa.md](./deploy-and-pwa.md)** — deploy command + the service-worker
  staleness / MIME-error traps that repeatedly looked like "my fix didn't ship".
- **[relayer-threat-model.md](./relayer-threat-model.md)** — what the gas-sponsoring
  relayer can/can't do (custody invariant vs. xDAI-drain threat), why payloads are
  offline-forgeable, the layered abuse defenses (per-signer / per-IP / global budget /
  Turnstile), the KV-atomicity residual, and the `/embed` origin-trust rule. Flow +
  sequence diagrams.
- **[relayer-architecture.md](./relayer-architecture.md)** — the shared `functions/_lib`
  module (single source of CREATE2 truth) and why drift strands funds; the hot-vs-cold
  send decision flow; request lifecycle; editing rules. Module + flow diagrams.
- **[STAGING.md](./STAGING.md)** — staging environment notes.

Open follow-ups (backend/architectural) live in the agent memory `wallet-audit-followups`.
