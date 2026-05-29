# Audience Brief 03 — WASP / Open-source

> **Format za / Format for:** the WASP (wasp-lang) community and open-source
> builders who'd self-host or contribute. Showcase + template invitation.
> **Derived from** the [SSOT](../wallet-blog-sourcebook.md) and
> [ADR 0010](../../decisions/0010-open-wallet-vision.md).

| | |
|---|---|
| **Language** | English (primary) |
| **Channels** | WASP Discord/community, GitHub README, X, dev.to |
| **Tone** | Builder-to-builder, candid about what's WIP. Invite contribution. |
| **Lean into** | `open-wallet` as the `open-saas` analog; brand-as-data; generic naming; pluggable attestation; the WASP rewrite story. |

## Pitch
**`open-wallet` — the `open-saas` analog for Web3 wallets.** Self-host your
own branded, self-custody EURe wallet. Brand-as-data from the first commit,
pluggable attestation, no seed phrases. Incubating as a WASP rewrite of a
production wallet.

## Key hooks
1. **It's real, not a toy** — derived from a production wallet
   (`wallet.domovina.ai`) with a validated on-chain send pipeline.
2. **Brand-as-data** — a new tenant is config, not a fork (proven: 3 live
   tenants in the parent).
3. **WASP rewrite** — full-stack in WASP; lives at
   `experiments/wallet-wasp/` as the seed for a community template.
4. **Pluggable identity** — attestation (phone, eID, zk) designed as
   swappable from day one.

## Posts for this audience (from backlog)
- **B7** — "open-wallet: the open-saas for Web3 wallets" → use the
  wallet-wasp screenshot set (`experiments/wallet-wasp/screenshots/`)
- (Cross-post) **B3/B5** as deep-dives that justify the architecture the
  template inherits.

## Canonical references
- [ADR 0010](../../decisions/0010-open-wallet-vision.md) — Open-Wallet vision + rename criteria
- [ADR 0007](../../decisions/0007-brand-as-data-white-label.md) — brand-as-data
- `experiments/wallet-wasp/` — the WASP rewrite (submodule)

## CTA
"Star `wallet-wasp` · try the template · open an issue with your brand."

## Guardrails (binding)
- **`open-wallet` is NOT a finished template yet** — it incubates in
  `experiments/wallet-wasp/`; rename criteria (ADR 0010) not yet met. Say
  "incubating / seed", not "released".
- Use the **WASP rewrite** screenshots (English UI) for this audience — not
  the Croatian production shots.
- Self-custody invariant (ADR 0001) is the headline constraint — keep it.
