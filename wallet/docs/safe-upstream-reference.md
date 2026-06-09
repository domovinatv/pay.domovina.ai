# Safe upstream reference (safe-wallet-monorepo)

A **local, read-only reference** to Safe's official, audited wallet implementation
(`safe-global/safe-wallet-monorepo` — the code behind **app.safe.global** and
**Safe Mobile**). We don't depend on it or build it; we **copy proven, audited
patterns** out of it into DOMOVINA Wallet with clear provenance.

## Where it lives — NOT a submodule

It is a **sibling clone outside this repo**, deliberately not a git submodule:

```
~/git/safe-global/safe-wallet-monorepo     ← the reference (full files, all branches/tags)
~/git/domovinatv/pay.domovina.ai/wallet    ← this project (copies patterns from there)
```

Why a sibling clone, not a submodule: we want the **always-latest** working copy
(`git pull`), full history/branches/tags locally, and **zero weight in this repo**.
A submodule would pin a single SHA and add the dependency to every clone of this
repo — wrong shape for a thing we only ever read and cherry-pick from. (Provenance
is preserved per-copy instead — see the workflow below.)

### Set up on a fresh machine

Blobless partial clone — all files on checkout + full history, but light (~70 MB
vs. a multi-hundred-MB full clone) and `git pull` works normally:

```bash
mkdir -p ~/git/safe-global
git clone --filter=blob:none \
  https://github.com/safe-global/safe-wallet-monorepo.git \
  ~/git/safe-global/safe-wallet-monorepo
```

### Keep it up to date

```bash
cd ~/git/safe-global/safe-wallet-monorepo
git pull            # default branch is `dev`
# or pin to a release tag when you want a stable reference point:
git tag --list | tail   # then: git checkout <tag>
```

## Layout map (what to copy from)

Default branch: **`dev`**. Monorepo (pnpm workspaces):

| Path | What | Closest to our… |
|---|---|---|
| `apps/web` | **app.safe.global** — Next.js multisig web client | tx-flow, signature collection, owner mgmt UX |
| `apps/mobile` | **Safe Mobile** — React Native client | our `wallet-mobile` Expo baseline (ADR 0014) |
| `apps/tx-builder` | Safe Apps tx-builder | batch/multiSend construction reference |
| `packages/utils` | shared services/hooks/utils (`src/{services,hooks,utils,features}`) | **most reusable logic** — Safe SDK wrappers, formatting, validation |
| `packages/store` | shared Redux/RTK store + constants | state shape reference |
| `packages/theme` | shared design tokens | — |

Useful entry points for our use cases:
- **EURe / ERC-20 transfer flow, MultiSend, nonce/threshold handling** → `apps/web/src/features` + `packages/utils/src/services`.
- **Passkey / WebAuthn**: Safe's own usage is sparse (`git grep -i passkey`), because
  in our model the passkey is a **signer, not a module** — our hand-rolled
  `src/lib/webauthnSig.ts` + `functions/_lib/safe.ts` are the canonical reference,
  cross-checked against Safe's `@safe-global/protocol-kit` derivations.

## Copy-with-provenance workflow (do this every time)

When you lift code from upstream into DOMOVINA Wallet:

1. Note the upstream commit you copied from:
   ```bash
   cd ~/git/safe-global/safe-wallet-monorepo && git rev-parse --short HEAD
   ```
2. Record it in the porting commit message and/or a code comment, e.g.
   `// ported from safe-wallet-monorepo@52b52134 apps/web/src/...`. This lets you
   `git log`/diff that path upstream later to pull in fixes.
3. **Adapt, don't paste blind** — Safe targets a generic multisig; we run a
   threshold-1 passkey/EOA Safe with a sponsoring relayer. Strip what doesn't apply.

## ⚠️ Licensing — READ before copying

The monorepo is **GPL-3.0** (`LICENSE` at root) and "Safe" is a **trademark**.

- Lifting non-trivial code into DOMOVINA Wallet carries **GPL-3.0 copyleft**
  obligations on the result — treat any substantial copy as making that surface
  GPL, or reimplement from the *idea* rather than the *source*.
- The Safe **contracts** are LGPL (linking-friendly) — that's the layer we already
  interoperate with on-chain; copying contract ABIs/addresses is fine.
- **Rebrand**: never ship Safe's name/marks. See the agent memory
  `reference_open_source_wallet_baseline` + ADR 0014 for the full
  fork-vs-reimplement decision and the passkey-as-signer rationale.

When in doubt, copy the *approach* and write our own implementation — which is also
why our relayer/CREATE2 code lives independently in `functions/_lib/` (see
[relayer-architecture.md](./relayer-architecture.md)).
