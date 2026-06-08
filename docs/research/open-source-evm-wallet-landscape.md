# Open-source EVM self-custody wallet landscape (for a rebrandable native wallet)

**Date:** 2026-06-08 · **Context:** picking a baseline + stack for a native
iOS/Android self-custody wallet over a passkey-owned Safe (see
[ADR 0014](../decisions/0014-mobile-wallet-baseline-and-stack.md)).

## Safe official repositories

| Repo | What | Status | Lang | Licence |
|---|---|---|---|---|
| [`safe-global/safe-wallet-monorepo`](https://github.com/safe-global/safe-wallet-monorepo) | **Current** — `apps/web` (app.safe.global), `apps/mobile` (Expo/RN), shared `packages/store` + `packages/utils` | Active (v1.81+) | TS / RN | GPL-3.0 |
| [`safe-global/safe-ios`](https://github.com/safe-global/safe-ios) | Old native iOS | **Archived** | Swift | GPL-3.0 |
| [`safe-global/safe-android`](https://github.com/safe-global/safe-android) | Old native Android (last release Jul 2024) | **Archived** | Kotlin | GPL-3.0 |

Native iOS/Android were **merged into one React Native app** inside the monorepo —
itself a strong signal that RN is production-grade for a wallet in 2026. Existing
rebrand forks to study: Fantom `sonic-safe-wallet-monorepo`, Kakarot
`safe-wallet-web`.

### Licensing reality (matters for rebrand)

- **GPL-3.0** copyleft: fork + commercial use allowed, but you must publish your
  source under GPL-3.0. You cannot close it.
- **Trademark ≠ licence:** "Safe" name/logo are trademarked (GPL §7). You may use
  the code but **must strip Safe branding**. Legal obligation, not cosmetics.

## `safe-global/safe-modules` — and a key conceptual trap

Repo: [`safe-global/safe-modules`](https://github.com/safe-global/safe-modules),
contracts **LGPL-3.0** (more permissive than the apps — linking does not infect your
codebase). Four packages: `passkey`, `4337`, `allowance`, `recovery`.

**The trap:** in Safe's security model these are different things:

| Layer | What it does | Bypasses owner threshold? |
|---|---|---|
| Owner + threshold | the multisig core | — (it *is* the rule) |
| **Signer** | a smart contract that **can be an owner**; signs via ERC-1271 | No — counts as one signature |
| **Module** | a contract that can execute a tx **bypassing owners/threshold** | **Yes — that's its point** |
| Guard / fallback handler | blocks txs / handles calls the singleton can't | — |

Our passkey setup (`SafeWebAuthnSignerFactory` + `DaimoP256Verifier`) is a **SIGNER,
not a module**, despite living in the "safe-**modules**" repo:

1. `createSigner(x, y, verifier)` deploys a tiny contract bound to one passkey's
   P256 pubkey.
2. That contract implements ERC-1271 `isValidSignature` — verifies the WebAuthn
   signature via the P256 verifier.
3. Its **address is added as an OWNER** of the Safe.

So a passkey-owned Safe is a **real multisig with a smart-contract owner**, not a
backdoor. The threshold is still honoured. (Contrast: `allowance` and `recovery`
ARE real modules — they move funds bypassing the threshold under limits/timelocks;
recovery modules deserve the same self-custody scrutiny as ADR 0001 rejected for
server recovery.)

The `4337` package is a **module + fallback handler** that makes a Safe an ERC-4337
account (bundler/EntryPoint + paymaster) — the standard alternative to our CF Worker
relay for gasless sends.

## React Native / Expo viability in 2026

- **Not a WebView.** RN renders native widgets; only RN-**for-web** renders to DOM.
- **The Bridge is gone.** New Architecture (JSI, Fabric, TurboModules, Hermes) is
  default in SDK 56 / RN 0.85 — the old async-JSON-bridge lag is the source of the
  stale "RN is bad" reputation.
- **Expo today** = CLI + SDK (local) + EAS (optional cloud). Config plugins +
  prebuild (CNG) allow **any** native module (passkey/biometrics). Dev Client is
  needed for custom native modules (Expo Go is not enough).
- **Mental model:** native binary = a runtime with a *vocabulary* of native component
  types; JS bundle = a *script* describing the tree + logic. Like a browser (binary)
  + HTML/JS (bundle) — but the "browser" renders native widgets.

### OTA updates (RN/Expo advantage Flutter/native lack)

Because JS stays as loadable Hermes bytecode (not AOT machine code), `EAS Update`
can flash changes to installed apps **without a store review**:
- **OTA-able:** new buttons, whole screens, layout, styles, logic, handlers, text,
  bundled assets — anything composed from native primitives already in the binary.
- **Needs a new build:** any **new native module** not yet compiled in, SDK/RN
  version bumps, native config (permissions, deep links, icons).
- Apple guideline 3.3.2 allows it provided you don't change the app's primary purpose.
- Flutter/Swift/Kotlin are AOT-compiled → no swappable bundle → no OTA.

### Why RN over Flutter *for us* (not in the absolute)

Decided by **code/language sharing with the existing React/TS web wallet**, not by
RN > Flutter. Flutter is equally native-class and Matija knows it well; the deciding
factor is reusing the validated passkey/Safe logic without a Dart rewrite, plus OTA.

## Other rebrandable references (not chosen, worth studying)

- **[Daimo](https://github.com/daimo-eth/daimo)** — GPL-3.0, **passkey-native** RN
  wallet using the **same P256 verifier** we do; closest architecture to ours (Base +
  own contract instead of Safe). Best UX reference for a passkey wallet.
- **[Coinbase Smart Wallet](https://github.com/coinbase/smart-wallet)** — MIT passkey
  smart-account *contracts* (not an app).
- **[Candide abstractionkit](https://github.com/candidelabs/abstractionkit)** — MIT
  ERC-4337 + passkey SDK.
- **[Rabby](https://github.com/RabbyHub/Rabby)**, **[Ambire](https://github.com/AmbireTech/wallet)**,
  **[Gem (Android)](https://github.com/gemwalletcom/gem-android)** — classic EVM
  wallets for rebrand reference (EOA, not passkey smart-account).
