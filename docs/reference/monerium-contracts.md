# Monerium EURe contracts — V1 vs V2 (canonical reference)

> Source of truth: **https://docs.monerium.com/contracts-v2** (read 2026-06-02).
> Token list: https://docs.monerium.com/tokens · Source: https://github.com/monerium/smart-contracts
> Use this page before touching any EURe address in this codebase.

## TL;DR

Monerium upgraded its e-money tokens (EURe, USDe, GBPe, ISKe) from **V1 → V2**.
On Gnosis the upgrade **completed 2024-08-25**. Both versions stay live and
**always report the same balance**, but they are different addresses and **emit
events differently**. **Always integrate against V2.**

## Gnosis EURe addresses

| | Name | Address | Code |
|---|---|---|---|
| **V2 (use this)** | `Monerium EURe` | **`0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430`** | proxy (state authority) |
| V1 (legacy) | `Monerium EUR emoney` | `0xcB444e90D8198415266c6a2724b7900fb12FC56E` | forwards to V2 |

Other chains (V1 → V2):
- Polygon: `0x18ec0A6E18E5bc3784fDd3a3634b31245ab704F6` → `0xE0aEa583266584DafBB3f9C3211d5588c73fEa8d`
- Ethereum: `0x3231Cb76718CDeF2155FC47b5286d82e6eDA273f` → `0x39b8B6385416f4cA36a20319F70D28621895279D`

(Also live on Arbitrum, Base, Linea, Scroll, Noble, Camino — see /tokens.)

## The event-log gotcha (critical for indexers)

V1 and V2 share balance state, but **logs differ**:
- Calling `transfer`/`transferFrom` on **V1** emits **two** `Transfer` events (one V1, one V2).
- Calling them on **V2** emits **one** event (V2 only).
- So V1 holds the full history **up to** a cutover block T; V2 holds everything **after** T.

**To index EURe correctly, transition from V1 logs to V2 logs at block T:**

| Chain | T (cutover block) | V1 address | V2 address |
|---|---|---|---|
| **Gnosis** | **35656951** | `0xcB444e90…` | `0x420CA0f9…` |
| Polygon | 60733237 | `0x18ec0A6E…` | `0xE0aEa583…` |
| Ethereum | 21419972 | `0x3231Cb76…` | `0x39b8B638…` |

For anything new (Gnosis is long past T), **index only V2 (`0x420CA0f9`)**. Watching
V1 (`0xcB444e90`) after T yields **zero** `Transfer` logs for post-cutover activity.

## V2 features

- **Permit (ERC-2612)** — gasless approvals via off-chain signatures. Tutorial:
  https://github.com/monerium/smart-contracts/blob/v2.0.0/docs/permit.md
- ~71% cheaper `transfer`, ~64% cheaper `approve` vs V1 (OpenZeppelin-based).
- Audited by Ackee Blockchain Security.

## How this codebase MUST use it

- **Rail** (`backend/`): `EURE_CONTRACT` env = **V2 `0x420CA0f9`** (Monerium mints/forwards V2 to destinations). ✅ already correct in prod.
- **On-chain indexer** (pinka donations): watch `Transfer` logs on **V2 `0x420CA0f9`** only.
- **pinka on-chain QR / transparency links**: reference **V2 `0x420CA0f9`**.
- **Wallet** (`wallet/src/lib/constants.ts` `EURE_ADDRESS`, `eip681.ts`): currently
  points at **V1 `0xcB444e90`** ⚠️ — this is the *legacy* token. It still works
  (V1 forwards to V2, same balance) but: (a) `eip681.ts` rejects V2 QRs as "drugi
  token", so it can't scan a correct V2 payment request; (b) wallet-initiated
  transfers go through V1, emitting events on V1 that a V2-only indexer won't see.
  **Recommendation: repoint the wallet to V2 `0x420CA0f9`** (verify the validated
  send + balance rendering first).

## Wallet display caveat (expected, not a bug)

A wallet may show **both** V1 and V2 EURe with the same balance (Monerium is
working with wallets/explorers to dedupe). Differentiate by name/address above.
