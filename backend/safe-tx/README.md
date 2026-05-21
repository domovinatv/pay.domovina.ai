# MPT Safe Transactions

Persisted Safe Transaction Builder batches for MPT's on-chain governance
operations — primarily setting up and managing the **Zodiac Roles Modifier**
that gates the backend's auto-forwarding from the MPT main-rail Safe.

Everything in this directory is reproducible: the `.mjs` generator scripts
take CLI flags, encode calldata with `viem`, and emit Safe Transaction
Builder JSON. The committed `*.template.json` files are the canonical
review artifact — regeneratable byte-for-byte from the script.

## Why this exists

The roles.gnosisguild.org dashboard is **read-only** in v2 (Create Role was
removed). Role configuration is now declarative — defined in code, reviewed,
signed via the Safe multisig, and persisted alongside the codebase for
audit. This directory is that persistence layer.

## Layout

```
safe-tx/
├── README.md                                            ← this file
├── 000-generate-backend-eoa.sh                          ← key generator (run in offline terminal)
├── 001-eure-forwarder-role-setup.mjs                    ← Safe batch generator (reproducible)
├── 001-eure-forwarder-role-setup.template.json          ← committed template (sentinel for EOA)
└── 001-eure-forwarder-role-setup.EXECUTED.json         ← post-execution audit copy (with real EOA + Safe TX hash in companion .md)
```

## Standing context (production values)

| Thing | Value |
|---|---|
| Network | Gnosis (chain id `100`) |
| MPT main-rail Safe | `0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e` (v1.4.1, 2/3) |
| Zodiac Roles Modifier (v2 instance) | `0x330347d656b1a5DF972f758DE1E25E99ec36762c` |
| EURe ERC-20 contract | `0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430` |
| Role name | `EUReForwarder` |
| Role key (bytes32) | `0x45555265466f7277617264657200000000000000000000000000000000000000` |

## Step 0 — generate the backend EOA (one-time)

Run in a **separate offline terminal** (not in Claude Code, not in a
screen-shared IDE, nowhere with capture):

```bash
./safe-tx/000-generate-backend-eoa.sh
```

Outputs `Address` + `Private key`. Move private key into 1Password (vault
item "MPT backend EOA") immediately; keep the public address handy for
step 001.

The script prefers `cast wallet new` (Foundry); falls back to
`openssl rand` + viem derivation if Foundry isn't installed.

## Reproducing batch 001 (EUReForwarder role setup)

### One-shot (recommended)

Generates a ready-to-upload batch with the backend EOA baked in:

```bash
node safe-tx/001-eure-forwarder-role-setup.mjs --eoa 0xYourBackendEOA
```

Output: `001-eure-forwarder-role-setup.EXECUTED.json`

### Two-shot (review template then patch)

```bash
# 1. Emit template with sentinel placeholder
node safe-tx/001-eure-forwarder-role-setup.mjs

# 2. Patch with sed (the placeholder string is exactly 40 chars)
EOA_LOWER_NO_0X=yourbackendeoaadress40hexcharslowercase  # no 0x prefix
sed "s/REPLACE_WITH_BACKEND_EOA_HEX_LOWERCASE_X/$EOA_LOWER_NO_0X/" \
  safe-tx/001-eure-forwarder-role-setup.template.json \
  > safe-tx/001-eure-forwarder-role-setup.EXECUTED.json
```

## What batch 001 does

Three calls against the Roles Modifier, in one Safe multisig transaction:

| # | Call | Effect |
|---|---|---|
| 1 | `scopeTarget(EUReForwarder, EURe)` | Registers EURe as a *scoped* target on the role. Functions must be individually whitelisted (vs `allowTarget` = wildcard). |
| 2 | `allowFunction(EUReForwarder, EURe, transfer(address,uint256), None)` | Whitelists ONLY the ERC-20 `transfer` selector. `options=None` = no native value, no DelegateCall, only plain Call. |
| 3 | `assignRoles(backendEOA, [EUReForwarder], [true])` | Grants the role to the backend EOA. The EOA can now submit `execTransactionWithRole(...)` calls that ultimately invoke `EURe.transfer(any, any)` via the Safe — and nothing else. |

## Uploading & executing

1. [app.safe.global](https://app.safe.global) → select MPT main-rail Safe
2. **Apps** tab → **Transaction Builder**
3. **Load batch** (button top-right) → select `*.EXECUTED.json`
4. Preview should show 3 transactions, all targeting `0x330347d656b1a5DF972f758DE1E25E99ec36762c`
5. **Create Batch** → **Send Batch**
6. 2 of 3 signers approve → execute on-chain
7. After execution, record the Gnosisscan TX URL in `001-eure-forwarder-role-setup.EXECUTED.md`

## Security checklist before signing

- [ ] `cfg.safe` in generator output matches the Safe you're signing from
- [ ] `cfg.roles` matches the Modifier deployed for this Safe (verify via `owner()` on-chain returns Safe address)
- [ ] `cfg.eure` is the canonical EURe contract `0x420CA0f9…3430` (not a lookalike)
- [ ] `--eoa` is the backend EOA you generated, NOT a paste from anywhere else
- [ ] You hold the private key for that EOA (verify by signing a test message in the wallet that generated it)
- [ ] The EOA has ~$1 worth of xDAI for gas before the first forward (after this batch executes you'll want to fund it)

## Adding new Safe operations

Each new operation gets its own `NNN-short-name.mjs` + `NNN-short-name.template.json`
pair. Examples of future batches that may belong here:

- `002-revoke-eure-forwarder-from-eoa.mjs` — emergency disarm if backend key compromised
- `003-rotate-eure-forwarder-eoa.mjs` — atomic revoke-old + assign-new (zero-downtime key rotation)
- `004-add-second-target-token.mjs` — extend role to forward USDC if/when we accept USD
- `005-scope-transfer-with-amount-cap.mjs` — replace any-amount with `amount ≤ X` condition

Keep the same numbering + reproducibility pattern.
