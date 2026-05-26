# ADR 0007 — Brand-as-data white-label architecture

**Status:** Accepted, implemented (PRs #47, #49, #50). Backfilled documentation.
**Date:** 2026-05-26 (decision date — implementation landed earlier same day)
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Inherits from:** ADR 0001 (self-custody — applies equally to all tenants).

## Context

wallet.domovina.ai is intended to be the first instance of a wallet
shell that other organizations (sports clubs, parishes, NGOs,
foundations, community DAOs) can adopt under their own brand without
forking the codebase. The 2026-05-26 session validated this need with
three sample tenants: `default` (DOMOVINA Wallet — navy + Croatian red),
`sportklub` (SK Wallet — SofaScore-blue + white sample), and `zupa`
(Župa Wallet — Vatican gold + white sample).

Three architectural patterns were considered:

1. **Fork per tenant** — each partner gets a copy of the repo, drift
   manually managed. Familiar but produces version skew that hurts
   security updates ("which tenants got the relay-bug fix?").
2. **Tenant branches** — single repo, one long-lived branch per tenant
   rebased on `main`. Less drift but every rebase costs effort, and a
   tenant that diverges meaningfully blocks itself off from upstream.
3. **Brand-as-data (single repo, runtime/build-time config)** — one
   codebase, brand-specific values (colors, copy, domain, feature
   flags) live in versioned data files; build-time selection via env
   produces per-tenant artifacts. Code stays unified.

Pattern 3 is chosen.

## Decision

### Decision 1 — Single repo, BrandConfig type as data

A new directory `wallet/src/brands/` holds one subdirectory per tenant:

```
wallet/src/brands/
  _shared/types.ts        # BrandConfig TypeScript shape
  default/brand.ts        # DOMOVINA Wallet config
  sportklub/brand.ts      # SK Wallet sample
  zupa/brand.ts           # Župa Wallet sample
```

Each `brand.ts` exports a single `const brand: BrandConfig` with
fields: `id`, `name`, `shortName`, `productSubtitle`, `domain`,
`pageTitle`, `colors { primary, primaryFg, accent, accentFg }`,
`copy { welcomeTitle, welcomeSubtitle, productName }`,
`enabledFeatures: string[]`.

No code lives under `brands/*` — only data. New tenant onboarding is
a single new `brand.ts` file plus a registration line in
`wallet/src/app/brand.ts`.

### Decision 2 — Build-time brand selection via VITE_BRAND env

The active brand is picked at build time by `VITE_BRAND` environment
variable; resolved by `wallet/src/app/brand.ts` against an imported
registry. Unknown id falls back to `default` with a console warning.

```bash
# Per-tenant build
VITE_BRAND=sportklub npm run build
# Convenience scripts
npm run build:default | build:sportklub | build:zupa
npm run ship:all   # builds + deploys all three sequentially
```

All brand configs are bundled into every brand's JS bundle (each is
~few hundred bytes; tree-shaking removes only minor overhead). When
the project grows past ~10 tenants, switch to dynamic-import resolution.

### Decision 3 — Per-tenant Cloudflare Pages projects

Each brand deploys to its own CF Pages project:
- `wallet-domovina` → `wallet.domovina.ai`
- `wallet-sportklub` → `wallet-sportklub.pages.dev` (custom domain
  `sportklub.domovina.ai` available via dashboard wiring, not
  automated)
- `wallet-zupa` → `wallet-zupa.pages.dev` (custom domain similarly
  manual)

Project name passed to wrangler via `BRAND_PROJECT` env. Single
`wrangler.toml` for shared config; per-deploy `--project-name=` flag
overrides target.

### Decision 4 — CSS variables for brand colors, semantic Tailwind tokens

`wallet/src/app/applyBrandCss.ts` converts brand `colors` from hex
to RGB triplet form, sets CSS variables on `<html>` (`--brand-primary`,
`--brand-primary-fg`, `--brand-accent`, `--brand-accent-fg`) before
the first React render. Tailwind config exposes `bg-brand-primary`,
`text-brand-accent-fg`, etc. utilities that read these variables.

The pre-existing dark/light `--surface-*` and `--ink-*` variables are
brand-independent and remain centralized in `wallet/src/styles/index.css`.

### Decision 5 — Static HTML head + PWA manifest brand-aware at build time

The runtime `applyBrandCss` swaps `document.title` after JS loads, but
crawlers, OG scrapers, and the iOS "Add to Home Screen" sheet see the
static HTML response first. Vite plugin `htmlBrandSubstitution`
replaces `%BRAND_TITLE%`, `%BRAND_THEME_COLOR%`, `%BRAND_APPLE_TITLE%`
placeholders in `index.html` at build time. PWA manifest is generated
from `brand.name` / `brand.shortName` / `brand.colors.primary` /
`brand.productSubtitle` via VitePWA config.

### Decision 6 — Tenant-specific custom features in `brands/<id>/custom/`

Custom features that don't make sense across all tenants (e.g. a
sponsor leaderboard for the sportklub brand) live in
`wallet/src/brands/<id>/custom/`. Core code in `wallet/src/core/` (or
`routes/` etc.) MUST NOT import from any `brands/<id>/` directory —
only the runtime `app/brand.ts` resolver may, and only the active
brand's config. Custom routes are mounted via `brand.enabledFeatures`
feature flags + lazy dynamic imports.

Promotion path "custom feature → core": refactor for brand-agnosticism,
move from `brands/<id>/custom/` to `core/features/`, add to default's
`enabledFeatures` list. Codified in commit messages, no separate ADR
required per promotion.

### Decision 7 — Linking buttons hide on master, show on tenants

A small UX convention: any "Linkaj postojeći wallet" affordance is
gated on `brand.id !== 'default'` for the original implementation.
**Note**: ADR 0008 (peer linking N-to-N) supersedes this — linking is
symmetric and the button now appears on every brand including default.
Kept here for historical record.

## Consequences

### Positive

1. **One repo, one CI matrix, instant fan-out.** A bug fix in
   `core/` ships to all tenants on next `npm run ship:all`. No
   tenant can lag behind on security updates.
2. **New tenant onboarding measured in commits, not branches.**
   Adding a fourth tenant is one PR adding `brands/<id>/brand.ts` +
   one registration line.
3. **White-label customization without engineering touch.** Brand
   primary color or welcome subtitle changes are data edits, not code
   reviews.
4. **Defendable niche for grant aplications.** Demonstrably scalable
   architecture: "we can spin up Croatian-citizen wallets for X
   municipalities / Y NGOs" is a credible pitch.
5. **Brand registry is symmetric for cross-tenant features.** ADR 0008
   uses the same registry to enumerate link targets, etc.

### Negative

1. **Tenant code isolation is convention, not enforcement.** A
   future contributor could import `brands/sportklub/custom/` from
   core. Add ESLint `no-restricted-imports` rule when the team grows
   past one person.
2. **Bundle ships all brand configs to every tenant.** Negligible
   today (~3 brands, few KB each) but worth revisiting at ~10+.
3. **Custom domain wiring stays manual.** Each new tenant needs DNS
   + CF Pages custom domain dashboard step. Tooling could automate
   via wrangler API; deferred until painful.
4. **Per-tenant icons + logos still shared.** All three live tenants
   use the same `/icons/*` PNGs today. Per-brand logo PNG
   substitution at build time is the next iteration.

### Neutral

1. **Wallet identity model (Safe + passkey) is brand-independent.**
   Tenants do not share Safe addresses with master by default; cross-
   tenant Safe sharing is the explicit "linking" pattern in ADR 0008.
2. **GDPR posture inherits per-tenant.** Each tenant operates under
   the same data-handling rules from ADR 0005; no per-brand legal
   posture differences allowed today.

## Implementation tracking

Implementation landed in three commits during the 2026-05-26 session:

| Component | Status | PR |
|---|---|---|
| D1: BrandConfig type + 3 brand configs + resolver | ✅ Shipped | #47 |
| D2: VITE_BRAND env + npm scripts (build/deploy/ship per brand) | ✅ Shipped | #47 |
| D3: CF Pages projects `wallet-sportklub` + `wallet-zupa` created via wrangler; `wallet-sportkluba` renamed to `wallet-sportklub` (grammatical fix) | ✅ Shipped | #47, #49 |
| D4: CSS variables + Tailwind tokens (`bg-brand-primary`, etc.) | ✅ Shipped | #47 |
| D5: Static HTML head + PWA manifest brand-aware via Vite plugin | ✅ Shipped | #50 |
| D6: `brands/<id>/custom/` directories | ⏳ Reserved | No active custom features yet across tenants |
| D7: Linking button gating | ➖ Superseded | By ADR 0008 |

Production deployments live as of 2026-05-26:
- https://wallet-domovina.pages.dev (alias `wallet.domovina.ai`)
- https://wallet-sportklub.pages.dev
- https://wallet-zupa.pages.dev

## References

- Single-repo white-label prior art:
  Vercel's Platforms Starter Kit, Shopify Hydrogen multi-store,
  Supabase per-tenant branding patterns.
- ADR 0001 — self-custody invariant (all tenants inherit equally).
- ADR 0008 — peer linking model that builds on brand registry.
- Memory: `[[reference-domovina-brand]]`.
