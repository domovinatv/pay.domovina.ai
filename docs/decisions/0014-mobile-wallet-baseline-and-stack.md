# ADR 0014 — Native mobile wallet: baseline & tech stack

**Status:** Proposed (leaning). Fresh Expo SDK 56 scaffold built as a throwaway
proof-of-toolchain (web + iOS + Android all build & run locally, no cloud). The
intended real baseline is a **fork of `safe-wallet-monorepo/apps/mobile`**, not
this scaffold.
**Date:** 2026-06-08
**Decision owners:** Matija Stepanic, ITalk d.o.o.
**Inherits:** ADR 0001 (self-custody), ADR 0007 (brand-as-data), ADR 0013
(passkey = identity, Safe = account).
**Related research:** [open-source EVM wallet landscape](../research/open-source-evm-wallet-landscape.md),
[local mobile build setup](../reference/local-mobile-build-setup.md).

## Context

`wallet.domovina.ai` is a Vite/React **web** PWA (passkey-owned Safe on Gnosis).
The next surface is **native iOS + Android**. Two questions had to be answered
before committing: (1) what tech stack, (2) what existing open-source baseline to
start from instead of writing a wallet from scratch.

### Stack: React Native / Expo is viable in 2026 (the old reputation is stale)

- **React Native is not a WebView/hybrid.** Cordova/Ionic/**Capacitor** render in a
  WebView; RN renders **real native widgets** (`UIView`/`android.view.View`). The
  "laggy hybrid" reputation came from the pre-2024 async **Bridge**, which is gone:
  the **New Architecture** (JSI synchronous calls, Fabric renderer, TurboModules,
  Hermes bytecode) is default in SDK 56 / RN 0.85.
- **Expo** is no longer a sandbox — config plugins + prebuild (CNG) allow **any
  native module** (passkey/WebAuthn, biometrics, secure enclave). EAS is optional
  cloud convenience; everything builds locally.
- **Airbnb-left-RN (2018) does not generalise.** Their reasons were half-technical
  (pre-Bridge) and half-**organisational** (two large existing native teams; RN
  added a third surface). Shopify made the opposite call (~2020, all-in, still on
  it) because they had no native monolit to defend and wanted one codebase. **We are
  the Shopify case, not the Airbnb case:** small team, existing React/TS web wallet,
  shared language + logic.
- **vs Flutter:** Flutter is equally non-hybrid and excellent, and Matija has years
  of Flutter. The single deciding factor is **code/language sharing with the existing
  React/TS web wallet** (passkey flow, tx building, ERC-1271 logic) — RN shares it,
  Flutter would mean a Dart reimplementation. Flutter also has **no OTA** (Dart is
  AOT-compiled); RN/Expo `EAS Update` can flash JS/UI changes without a store review
  (within Apple guideline 3.3.2 — must not change the app's primary purpose).

### Baseline: fork `safe-wallet-monorepo`, don't write from scratch

Official Safe repos (all **GPL-3.0**):
- [`safe-global/safe-wallet-monorepo`](https://github.com/safe-global/safe-wallet-monorepo)
  — **current**, active. `apps/web` (= app.safe.global), `apps/mobile`
  (Expo/React Native iOS+Android), shared `packages/store` + `packages/utils`.
- `safe-global/safe-ios` (Swift) and `safe-global/safe-android` (Kotlin) — **archived**;
  native development was merged into the RN app in the monorepo.

The fork path is validated by precedent (Fantom `sonic-safe-wallet-monorepo`,
Kakarot `safe-wallet-web`).

## Decision

1. **Stack = React Native + Expo (SDK 56, RN 0.85, New Architecture).** Reasons:
   code/language sharing with the web wallet, one codebase for iOS+Android, OTA.
2. **Baseline = fork `safe-wallet-monorepo/apps/mobile`** for the native shell
   (account list, tx UI, WalletConnect, settings), rather than the blank Expo
   scaffold.
3. **Web stays separate.** The existing Vite/React `wallet/` remains the web SSOT;
   we do **not** adopt `apps/web` (RN-for-web renders to DOM and we already have a
   better web wallet).

## The one hard caveat — passkey-owner is NOT in the Safe app

This is the load-bearing risk. Safe's official apps are built around the **classic
model: EOA owners + WalletConnect/hardware signer.** Our wallet is a **Safe whose
owner is a WebAuthn passkey signer** (`SafeWebAuthnSignerFactory` + `DaimoP256Verifier`,
the passkey **signer** — an ERC-1271 owner contract, *not* a Safe "module"; see
research doc).

Therefore "fork Safe app and repaint the UI" does **not** give us passkey
self-custody for free. The passkey-owner flow (WebAuthn → ERC-1271 → MultiSend
deploy+send) — which is already **validated** in `wallet/` (real Gnosis tx,
[[project_wallet_send_validated]]) — must be **ported into the fork**. That ported
flow is our actual value; the Safe shell is just scaffolding around it.

## Licensing constraints (must respect)

- **GPL-3.0 (wallet apps):** forking is fine, but our fork must be published under
  GPL-3.0 — fine for an open-source self-custody wallet, but we cannot close the
  source. Aligns with ADR 0010 (open-wallet vision).
- **Trademark ≠ licence:** "Safe" name + logo are trademarked. We must **remove Safe
  branding** and apply DOMOVINA brand (ADR 0007). This is a legal obligation, not
  just cosmetics.
- **Passkey/4337 contracts** (`safe-global/safe-modules`) are **LGPL-3.0** — we may
  use/link them without our app becoming LGPL (only changes to those contracts must
  be shared). Good for us — these are the contracts we already deploy on Gnosis.

## Status of the throwaway proof

A blank Expo SDK 56 app at `/Users/ms/git/domovinatv/wallet-mobile` (separate repo,
no remote) proves the **local toolchain** end-to-end on the M4 Pro:
web (`dist/`), iOS (live on iOS 26.3 simulator), Android (`app-debug.apk`, installed
& running on a physical Motorola Edge 30 Ultra over `adb`). The environment fixes
required (JDK 17, foojay, disk) are in the
[local mobile build setup runbook](../reference/local-mobile-build-setup.md). This
scaffold can be discarded once the Safe-monorepo fork is stood up.

## Open questions / next slice

- Fork `apps/mobile` and strip Safe branding → DOMOVINA brand-as-data.
- Port the passkey-owner signer flow from `wallet/` into the fork (needs an Expo
  **Dev Client** — Expo Go can't load the native passkey module).
- Decide gasless path: keep the existing CF Worker relay vs adopt the Safe `4337`
  module (bundler + paymaster). Separate ADR.
