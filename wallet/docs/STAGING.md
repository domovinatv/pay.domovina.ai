# Staging — wallet-staging.domovina.ai

A separate Cloudflare Pages project (`wallet-staging`) that runs the **default**
brand frontend for testing **before** rolling a release to stable
`wallet.domovina.ai`. It shares the **same backend** as production:

- Same Gnosis chain, same Monerium EURe.
- Same registry / payment-intent API (`mpt.domovina.ai`).
- Same `RELAY_KV` namespace + `GNOSIS_RPC_URL` var (from `wrangler.toml`).

**Why a `*.domovina.ai` custom domain (not just `*.pages.dev`):** WebAuthn
passkeys are scoped to RP ID `domovina.ai` (see `deriveRpId` in
`src/lib/constants.ts`). On a `*.pages.dev` origin the RP ID becomes that host, so
existing passkeys are invisible and recovery/cross-domain flows can't run. The
custom domain keeps staging passkeys identical to production.

## Deploy

```bash
npm run ship:staging      # build:default + deploy to wallet-staging (production branch)
```

`deploy:staging` forces `--branch main` so the deploy always lands on the staging
**production** deployment (= what the custom domain serves), even when you deploy
from a feature branch. Stable stays untouched — ship to it separately with
`npm run ship:default`.

## One-time setup (done once per CF account)

1. **Project**: `wrangler pages project create wallet-staging --production-branch main` ✅ (done)
2. **Custom domain** — Cloudflare dashboard → Pages → `wallet-staging` → Custom
   domains → **Set up a custom domain** → `wallet-staging.domovina.ai`. Since the
   `domovina.ai` zone is on the same account, CF auto-creates the CNAME. (No
   `wrangler` CLI command exists for this.)
3. **Relayer secret** (needed for on-chain deploys/sends/recovery):
   ```bash
   wrangler pages secret put RELAYER_PRIVATE_KEY --project-name=wallet-staging
   ```
   Use the same funded gas-sponsor EOA as production (or a separate funded one).

`RELAY_KV` + `GNOSIS_RPC_URL` come from `wrangler.toml` automatically on each
deploy (same as the brand projects).
