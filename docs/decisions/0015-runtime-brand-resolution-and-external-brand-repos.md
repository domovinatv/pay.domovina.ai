# ADR 0015 — Runtime brand resolution + external brand repos for flagship customers

**Status:** Accepted (partial rollout). Runtime resolver code shipped to `wallet/`
(commit `45b49d5`); `ship:multi` to production wallet.domovina.ai is **paused** (not
yet run). First external-repo customer (e-Demokracija) is live as a separate
prototype repo.
**Date:** 2026-06-15
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Inherits:** ADR 0007 (brand-as-data), ADR 0001 (self-custody), ADR 0010 (open-wallet).

## Context

ADR 0007 made branding **data** (`BrandConfig`), but selection was **build-time**
(`VITE_BRAND` → one CF Pages project per brand). Two problems surfaced when planning
branded wallets for many communities (clubs, parishes, towns) and one flagship
customer (udruga **e-Demokracija**):

1. **Build-time-per-brand does not scale** to a long tail of communities — N CF Pages
   projects, N `ship:` scripts, N deploys.
2. **Per-brand same-origin relayer duplication.** The relay (`/api/relay`,
   `/api/bootstrap-deploy`) is called as **same-origin Pages Functions** (`fetch('/api/relay')`,
   see `wallet/src/lib/relay.ts`). A separate Pages project = separate Functions =
   **its own `RELAY_KV` + `RELAYER_PRIVATE_KEY`** = a second relayer. The intents API,
   by contrast, is the shared remote Worker at `mpt.domovina.ai` (host-agnostic, CORS).
3. **A flagship customer wants bespoke design**, not a recolored config — custom DOM/CSS,
   fonts, layout. Brand-as-data (colors/copy) is the floor, not the ceiling.

## Decision

**Two tiers of branding:**

### A) Light brands → runtime hostname resolution, one deployment
`resolveActiveBrand()` (in `wallet/src/app/brand.ts`) now resolves:
`VITE_BRAND` build override → **`location.hostname` match against `brand.domain`** → `default`.
A single deployment (`wallet-domovina`) can serve every config-only brand by hostname:
**one relayer, one `RELAY_KV`, one `RELAYER_PRIVATE_KEY`**, shared `mpt.domovina.ai`
intents. Build with **no `VITE_BRAND`** (`npm run build:multi` / `ship:multi`).
"Periodically fetch upstream" becomes a non-problem: there are no forks to drift —
one deploy updates all brands.

### B) Flagship/bespoke brands → separate repo consuming the core
A customer who needs a genuinely custom-designed wallet gets a **separate repo** that
**reuses the functional core** and replaces all UI. Sequence: **prototype-first**
(design with mock data) → extract core → consume via **git submodule** (Phase 3).
The new repo points `VITE_PAYMENT_INTENT_API_BASE=https://mpt.domovina.ai` (shared)
and hosts its **own** relay (`/api/relay`) with its own `RELAYER_PRIVATE_KEY`, or calls
the existing relay cross-origin.

**Core boundary (verified):** `wallet/src/lib/*` + `src/state/*` + `functions/_lib/*`
are brand-agnostic **except** `lib/passkey.ts` and `lib/paperWallet.ts` (cosmetic
`brand.*` references — parameterize at the seam). Routes/components/ui are pure
presentation (rebuilt per brand). See first instance for the full mapping.

**First instance:** e-Demokracija — `github.com/edemokracija/novcanik-prototip`
(separate repo, NOT in this monorepo). Live: `edemokracija-novcanik.pages.dev`.

## Consequences

- Config-only brands ship as a `brand.ts` + hostname; bespoke brands get their own repo.
- The same-day-demo stopgap (standalone `wallet-edemokracija` CF Pages project + generic
  `edemokracija` brand in this monorepo, commit `0850283`) is **superseded** by the
  dedicated repo; do not point `edw.domovina.ai` at the generic build.
- Build-time bits that can only bake one brand per deployment (index.html `<title>`/theme,
  PWA manifest) stay on the build brand; the in-app experience self-corrects at first paint.
  A per-hostname dynamic manifest is a tracked follow-up.
- `ship:multi` to prod is paused pending the decision to host light brands centrally.

## Related

- External repo + its learnings: `github.com/edemokracija/novcanik-prototip` (`CLAUDE.md`,
  `docs/compliance/`).
- Recurring-payment-in-self-custody, edEUR loyalty/EMI, and tax-transparency designs were
  developed in that repo's `docs/compliance/` (prepaid + push-approval; soulbound token +
  `isEMILicenseActive` multisig flag; onchain tax transparency).
