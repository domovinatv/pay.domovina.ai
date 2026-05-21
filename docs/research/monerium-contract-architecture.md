# Monerium contract architecture on Gnosis

> Research note compiled 2026-05-21 for the MPT (Mint Pay Transfer) team.
> Every concrete claim is cited. On-chain claims were verified directly via
> the public Gnosis JSON-RPC (`https://rpc.gnosischain.com`) on 2026-05-21;
> off-chain claims are linked to Gnosisscan, Monerium's GitHub, and the
> Ackee Blockchain Security audit summary.

## TL;DR

- **EURe on Gnosis is upgradable.** The address we point to
  (`0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430`) is an OpenZeppelin
  `ERC1967Proxy` using the **UUPS** pattern. The implementation has been
  swapped 3 times on Gnosis, most recently on **2024-08-30** to the current
  `GnosisControllerToken` at `0x60cB9fdd0FCFd9bB3B2B721864db5E7c07F4635D`.
- **Upgrades are gated by a Gnosis Safe (v1.3.0) at
  `0x8001Ea269cB9715Bf7Acff89C664fFC134a519ec` with threshold 3 of 6.**
  That Safe is the proxy's `owner()`. There is no on-chain timelock between
  proposal and execution — the moment 3 of 6 Monerium signers sign, the new
  implementation is live.
- **Day-to-day minting is delegated to a single EOA**
  (`0x882145B1c33fbBC0b03875d4aBa5E5D6c84010Ef`) holding the `SYSTEM_ROLE`,
  bounded only by a per-account "mint allowance" that the owner-Safe can
  adjust. Burns and `recover()` also require `SYSTEM_ROLE`.
- **Compliance/blacklisting lives in a separate, also-upgradable Safe-owned
  contract** — the `BlacklistValidatorUpgradeable` proxy at
  `0xfE74A522768547bE33a3ad40b999381d57F238A0`. Every transfer calls
  `validator.validate(...)` and reverts if either sender or receiver is
  banned.
- **Practical takeaway for MPT:** Monerium itself runs an upgradable,
  multisig-gated, but timelock-less stack with one hot minter key. Our
  `PaymentRegistry.sol` is in fact *more* conservative than Monerium's own
  contracts on the dimensions of upgradability and admin keys — which is
  appropriate, because we store no value.

## EURe contract topology

### Address tree (Gnosis Chain, verified on-chain 2026-05-21)

```
EURe (user-facing address)
  0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430        ← ERC1967Proxy (UUPS)
  │
  ├── EIP-1967 implementation slot
  │     0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
  │     →  0x60cB9fdd0FCFd9bB3B2B721864db5E7c07F4635D
  │        (GnosisControllerToken, the V2 logic contract)
  │
  ├── EIP-1967 admin slot
  │     0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103
  │     →  0x0000…0000   (unused — this is UUPS, not Transparent)
  │
  ├── owner()         →  0x8001Ea269cB9715Bf7Acff89C664fFC134a519ec
  │                     (Gnosis Safe v1.3.0, threshold 3 of 6)
  │
  ├── validator()     →  0xfE74A522768547bE33a3ad40b999381d57F238A0
  │                     (ERC1967Proxy → BlacklistValidatorUpgradeable)
  │
  ├── SYSTEM_ROLE     →  0x882145B1c33fbBC0b03875d4aBa5E5D6c84010Ef  (EOA, hot minter)
  │
  ├── ADMIN_ROLE      →  (set by owner-Safe, controls mint allowances)
  │
  └── deployer        →  0xc5F3370131bB7ce0D28D83735447576aAeD1b993
                        (Gnosisscan label: "Monerium: Deployer", an EOA)
```

### Proxy pattern: UUPS

The implementation source is verified on Gnosisscan as
`GnosisControllerToken` and inherits, in order:

> `ERC20PermitUpgradeable, AccessControlUpgradeable,
> Ownable2StepUpgradeable, UUPSUpgradeable, MintAllowanceUpgradeable,
> SystemRoleUpgradeable`

— see the verified source at the implementation address.[^impl-source]
The upgrade authorization is the standard UUPS hook:

```solidity
function _authorizeUpgrade(address newImplementation)
    internal override onlyOwner {}
```

`onlyOwner` here comes from `Ownable2StepUpgradeable`. The owner is the
Safe at `0x8001Ea…519ec` (verified by `owner()` call returning that
address — see "Empirical verification" below). Because UUPS keeps the
upgrade logic in the implementation, a buggy implementation can in
theory brick future upgrades; this is the standard UUPS trade-off and is
the same trade-off USDC explicitly avoids by using the Transparent
pattern instead.[^uups-tradeoff]

### Upgrade history (Upgraded events on `0x420CA0f9…`)

Pulled directly via `eth_getLogs` on
`0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430` filtered by topic
`bc7cd75a…2e5c2d3b` (`Upgraded(address)`):

| Block       | UTC time                | New implementation                         | Tx                                                                 |
| ----------- | ----------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| 35,656,508  | 2024-08-25 06:00:50Z    | `0x06d53cbda1ebc80e99c76861777d0537d584450e` | `0xb4ccdfc5…cf6b8` (deployment of proxy with initial impl)        |
| 35,736,390  | 2024-08-30 00:39:25Z    | `0x60536559f62608fbcf30dda459ec2bcf88b1919a` | `0x07c65e41…d89676`                                                |
| 35,736,573  | 2024-08-30 00:55:25Z    | `0x60cB9fdd0FCFd9bB3B2B721864db5E7c07F4635D` | `0x21754d1c…3cb19`                                                 |

In other words: V2 was first wired up on 2024-08-25 with implementation
`0x06d53c…450e`, then re-pointed twice within a 16-minute window on
2024-08-30 (the second swap on 2024-08-30 was just 16 minutes after the
first — almost certainly a deploy-and-immediately-fix sequence). The
current implementation has been stable since.

### Empirical verification (commands you can re-run)

```bash
# Implementation slot
curl -s -X POST https://rpc.gnosischain.com -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_getStorageAt",
           "params":["0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430",
                     "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
                     "latest"],"id":1}'
# → 0x000000000000000000000000 60cB9fdd0FCFd9bB3B2B721864db5E7c07F4635D

# owner()  (0x8da5cb5b)
curl -s -X POST https://rpc.gnosischain.com -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_call",
           "params":[{"to":"0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430",
                     "data":"0x8da5cb5b"},"latest"],"id":1}'
# → 0x000000000000000000000000 8001Ea269cB9715Bf7Acff89C664fFC134a519ec

# Confirm owner is a Safe: VERSION() returns 1.3.0
curl -s -X POST https://rpc.gnosischain.com -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_call",
           "params":[{"to":"0x8001Ea269cB9715Bf7Acff89C664fFC134a519ec",
                     "data":"0xffa1ad74"},"latest"],"id":1}'
# → "1.3.0"

# Safe threshold and signers
# getThreshold() = 0xe75235b8  → 3
# getOwners()    = 0xa0e67e2b  → 6 addresses (see Governance section)
```

## Governance / multisig pattern

### The owner Safe

`0x8001Ea269cB9715Bf7Acff89C664fFC134a519ec` on Gnosis Chain. Confirmed via
direct contract calls 2026-05-21:

- **Safe version:** 1.3.0 (return of `VERSION()` selector `0xffa1ad74`).
- **Threshold:** 3 (`getThreshold()` returns `3`).
- **Owners (6, from `getOwners()`):**

| #  | Owner address                                  |
| -- | ---------------------------------------------- |
| 1  | `0x26338dc69Fc608719F444d5b8726f7Fd2c7A4787`  |
| 2  | `0x98f3aE9569f88513CF260B850730d42D9470CFE2`  |
| 3  | `0xCb124A864489382D072aAA19F715c4CD836E57be`  |
| 4  | `0x02C4D14022f7779e5F1ED4224A4BDE3e166e35F0`  |
| 5  | `0x431D580632D95804ccb74B4F2DFa22EF58Ecf027`  |
| 6  | `0x613121De604b432751E31e5bC92bC070A1E8fd07`  |

These six addresses are not publicly attributed to specific named
individuals, but Monerium's documentation describes the admin address as
"a Gnosis MultiSig wallet, operated by Monerium's administrative
personnel".[^monerium-multisig]

### Threshold history

The Ackee Blockchain Security audit of June–July 2023 explicitly flagged
the previous threshold of **2 of 6** as "severely weak" (finding M3,
"Weak ownership"), and recommended raising it.[^ackee-summary] Monerium
then raised it to **3 of 6**, which is what we observe on Gnosis today.
This is one of the few publicly documented post-audit governance
changes Monerium has made.

### Timelock: none

There is **no on-chain timelock** between proposal and execution. Once
3 of 6 Safe signers sign an `upgradeToAndCall(...)` transaction, the
implementation flips in the same block. This is materially weaker than
USDC's design (which historically uses a multisig + manual operational
delay), and dramatically weaker than DAI's MakerDAO `GSM Pause Delay`
(16 hours minimum between executive vote pass and effect[^dai-gsm]).

There is also no public governance forum / proposal process; changes
appear to be coordinated internally by Monerium and executed by the Safe
signers.

### Governance process (what is documented)

Monerium publishes no governance forum, MIP-style process, or staged
voting. The documented model is:

> "The admin address corresponds to a Gnosis MultiSig wallet, operated
> by Monerium's administrative personnel. They perform daily evaluations
> and adjustments to the mint allowance."[^monerium-multisig]

So: parameter changes (per-account mint allowances) are routine and
done by the admin role, while the heavy levers (validator swap, owner
transfer, implementation upgrade) require the 3-of-6 Safe.

## Admin function inventory

Roles defined in `SystemRoleUpgradeable`:[^systemrole-src]

```solidity
bytes32 public constant SYSTEM_ROLE = keccak256("SYSTEM_ROLE");
bytes32 public constant ADMIN_ROLE  = keccak256("ADMIN_ROLE");
```

The owner (via `Ownable2StepUpgradeable`) grants and revokes these.

| Function                                          | Who can call                             | On-chain delay | Last-known invocation                                                            |
| ------------------------------------------------- | ---------------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `mint(to, amount)`                                | any `SYSTEM_ROLE`                        | none           | Continuously by `0x882145B1…010Ef` (the hot minter EOA)                          |
| `burn(from, amount, h, signature)`                | any `SYSTEM_ROLE` (with EIP-712 sig)     | none           | Continuously by the same EOA                                                     |
| `recover(from, to, h, v, r, s)`                   | any `SYSTEM_ROLE` (with user signature)  | none           | Rare; signature-gated recovery flow                                              |
| `setMintAllowance(account, amount)`               | any `ADMIN_ROLE`                         | none           | "Daily evaluations and adjustments"[^monerium-multisig]                          |
| `setMaxMintAllowance(amount)`                     | any `ADMIN_ROLE`                         | none           | n/a                                                                              |
| `addSystemAccount` / `removeSystemAccount`        | `onlyOwner` (the Safe)                   | none           | Requires 3-of-6                                                                  |
| `addAdminAccount` / `removeAdminAccount`          | `onlyOwner` (the Safe)                   | none           | Requires 3-of-6                                                                  |
| `setValidator(address)`                           | `onlyOwner` (the Safe)                   | none           | Last set to `0xfE74A5…38A0` at V2 deployment (2024-08-25)                        |
| `transferOwnership` / `acceptOwnership`           | `onlyOwner` then `pendingOwner`          | two-step       | `pendingOwner()` currently `0x0` (no transfer pending)                           |
| `upgradeToAndCall(impl, data)`                    | `onlyOwner` (the Safe), via UUPS         | none           | Three times on Gnosis: 2024-08-25, 2024-08-30 (×2)                               |

There is **no `pause()`** function on the token. The "kill switch" is
the validator: the owner-Safe can either swap to a validator that
returns `false` for all transfers, or have an `ADMIN_ROLE` ban a
specific address via `BlacklistValidatorUpgradeable.ban(address)`.
This is the same design pattern as Circle's USDC `blacklister` role,
but with a separate proxy contract instead of an in-token mapping.

### The validator side-stack

`0xfE74A522768547bE33a3ad40b999381d57F238A0` is itself an `ERC1967Proxy`
delegating to `0x614fCC5b7f621a01731a7598e3c9645a6b0388e0`, the
`BlacklistValidatorUpgradeable` implementation.[^validator-source] It
inherits `Initializable, Ownable2StepUpgradeable, AccessControlUpgradeable,
UUPSUpgradeable, IValidator`. Functions:

| Function           | Modifier            | Notes                                                |
| ------------------ | ------------------- | ---------------------------------------------------- |
| `ban(address)`     | `onlyAdminAccounts` | Adds to blacklist, emits event                       |
| `unban(address)`   | `onlyAdminAccounts` | Removes from blacklist                               |
| `isBan(address)`   | view                | Public                                               |
| `validate(...)`    | called by Token     | Returns `false` if sender or receiver is banned      |
| `_authorizeUpgrade`| `onlyOwner`         | Upgrade gated by the same owner-Safe                 |

Because every transfer (including `transferFrom`) calls
`validator.validate(...)`, the owner-Safe has, in effect, a **pause
button by way of swapping the validator implementation** — but there is
no `paused()` flag a user-facing wallet can read. Croatian gloss: ovo je
"meka pauza" — postoji, ali je nevidljiva s vanjskog read API-ja.

## Audits + incidents

### Audits

All known public Monerium audits are by **Ackee Blockchain Security**.
The repository's `audits/` directory contains three PDFs:[^audits-dir]

| File                                                                  | Subject                | Approx. publish date |
| --------------------------------------------------------------------- | ---------------------- | -------------------- |
| `v1.1.0-ackee-blockchain-monerium-smart-contracts-report-1.2.pdf`     | V1, first review       | early 2024 (commit `4ac9f82`, 2024-03-07)[^audits-dir] |
| `v1.2.1-ackee-blockchain-monerium-smart-contracts-report-2.1.pdf`     | V1, follow-up review   | early 2024 (added in same window) |
| `v2.0.0-ackee-blockchain-monerium-smart-contracts-report-1.2.pdf`     | V2 (current Gnosis impl) | 2024-08-06 (commit `ec59a36`, "Feat/v2 (#45)")[^audits-dir] |

The publicly available **audit summary** for V1 (Ackee, conducted
2023-06-15 to 2023-07-04) reports:[^ackee-summary] [^ackee-medium]

- 0 Critical, 0 High, **3–5 Medium**, 1 Low, 3–6 Warning, 2–6 Informational
  (Ackee's blog and the Medium re-post disagree on the count of W/I
  findings; both agree on 0 Critical / 0 High).
- Key medium-severity issues:
  - **M3 "Weak ownership"** — 2-of-6 multisig threshold flagged as
    severely weak. **Fixed:** Monerium raised the threshold to 3 of 6,
    which is the current state on Gnosis.
  - **M1** access control architecture concerns.
  - **M2** renounce-ownership exposure.
  - **M4** unchecked return values.
  - **M5** missing decimals validation.
- Auditor's overall verdict on V1: "overall code quality and
  architecture are not the best" with "many violations of Solidity
  development best practices". V2 (the version currently deployed on
  Gnosis) is the redesign that followed.

No second auditor (ChainSecurity, Halborn, Trail of Bits, OpenZeppelin)
has published a Monerium audit as of 2026-05-21. Searches across each
firm's public report list returned nothing.

### Incidents

**Public-record incidents involving the EURe contracts: none found.** We
could not find any public report of a hack, drain, halted-mint event, or
emergency pause. The 16-minute repeated upgrade on 2024-08-30 (two
`Upgraded` events within the same V2 launch window) most likely
represents an internal hot-fix during deployment rather than an
incident, but Monerium has not publicly documented it; this is an
inference, not a confirmed claim.

## Industry positioning

Brief comparison so we can place Monerium on the centralization
spectrum.

### USDC (Circle)

USDC's token contract uses OpenZeppelin's **Unstructured Storage proxy
(a Transparent-style pattern, not UUPS)**, which separates
`ProxyAdmin`, `Owner`, `MasterMinter`, `Pauser`, `Rescuer`, and
`Blacklister` roles.[^usdc-roles] In practice Circle keeps both the
ProxyAdmin and the Owner inside multisig wallets, so multiple keys must
sign before an upgrade or ownership change is accepted; Circle has not
publicly disclosed signer counts or threshold. There is no on-chain
timelock; operational delays are policy, not bytecode. USDC has a
genuine `pause()` function exposed to a dedicated `Pauser` role —
unlike EURe.

### EURC (Circle, EUR-denominated)

Same `FiatTokenV2_*` codebase as USDC, deployed on multiple chains. Same
role hierarchy (ProxyAdmin / Owner / MasterMinter / Pauser / Rescuer /
Blacklister), same lack of on-chain timelock, same multisig governance
in practice. Useful comparison because EURC is the most direct competitor
to EURe at the regulatory layer (both are MiCA-relevant euro
stablecoins).

### DAI (MakerDAO / Sky)

Architecturally the outlier. DAI's core contracts are **not
upgradable**; changes require deploying new modules and routing
authority through the `MCD_PAUSE` contract. Governance is on-chain via
MKR voting, with the **GSM Pause Delay** enforcing a minimum of 16 hours
(historically longer) between an executive vote passing and the change
taking effect.[^dai-gsm] DAI also has a documented
**Emergency Shutdown** path triggered by depositing MKR.[^dai-es] In
short: DAI's design assumes adversarial governance and bakes in delay.
Monerium's design assumes trustworthy governance and does not.

### Where Monerium sits

| Property                       | DAI                 | USDC               | EURe (Monerium)              |
| ------------------------------ | ------------------- | ------------------ | ---------------------------- |
| Upgradable token contract?     | No                  | Yes (Transparent)  | Yes (UUPS)                   |
| On-chain timelock?             | Yes, 16h+ (GSM)     | No                 | No                           |
| Multisig signers / threshold   | DAO vote + delay    | Multisig (private) | **3 of 6 Safe (public addrs)** |
| Pause function on token?       | n/a                 | Yes (`Pauser`)     | No (via validator swap)      |
| Blacklist?                     | No                  | Yes (`Blacklister`)| Yes (separate validator)     |
| Single hot mint key?           | No                  | `MasterMinter` issues bounded minters | **One EOA holds `SYSTEM_ROLE`** |
| Independent audits?            | Many                | Many               | **Only Ackee Blockchain**    |

EURe is roughly "USDC's role model without the timelock and with one
auditor instead of many", which is consistent with Monerium being a
smaller, EU-regulated e-money institution rather than a US-regulated
issuer.

## Implications for MPT PaymentRegistry

Three things to keep in mind, none of which call for changes to
`PaymentRegistry.sol` today:

1. **Our blast radius vs. Monerium's blast radius.** A compromise of the
   3-of-6 Safe at `0x8001Ea…519ec` (or of the single hot-minter EOA
   `0x882145B1…010Ef`) can mint arbitrary EURe or freeze every transfer
   by swapping the validator. A compromise of the MPT 2/3 Safe at
   `0x449aBCEf…BaF2e` can at worst withdraw funds the Safe holds and
   change Zodiac role policy — it cannot mint or burn EURe. Because
   `PaymentRegistry.sol` is stateless (event-only) and holds no value,
   *even a full key compromise on our side has no on-chain financial
   blast radius beyond log spam.* This is a feature; preserving it
   should be the default when future contributors propose "just one
   small admin function".

2. **If we ever add admin to `PaymentRegistry`, copy Monerium's
   *separation of concerns*, not their *threshold*.** The thing
   Monerium gets right is splitting `owner` (rare, multisig-gated,
   touches upgrades and role membership) from `ADMIN_ROLE` (frequent,
   parameter tuning) from `SYSTEM_ROLE` (the hot mint key that does the
   actual work). If we ever introduce, say, a `setReceiver(address)` on
   `PaymentRegistry`, the right reflex is: gate it by our 2-of-3 Safe,
   never by an EOA — and ideally route through Zodiac Roles with the
   same allow-list discipline we already use for the EURe→xDAI swap on
   CowSwap. The thing Monerium gets noticeably less right by 2026
   standards is the **absence of a timelock**; if MPT ever holds funds
   on behalf of users, we should be willing to add the 24–72h delay
   that Monerium has not.

3. **We depend on a single Monerium hot key for mint.** Every euro that
   ever enters our pipeline gets minted by
   `0x882145B1c33fbBC0b03875d4aBa5E5D6c84010Ef`. If that key rotates
   (which it will, periodically) or is compromised, EURe mint behavior
   changes for everyone, not just us. There is no way for us to harden
   ourselves against this on-chain; the mitigation is operational —
   alert on a) any `RoleGranted(SYSTEM_ROLE, …)` event on
   `0x420CA0f9…3430`, b) any `Upgraded(...)` event on the proxy, and
   c) any `setValidator(...)` call by the owner-Safe. Treat any of
   these as a "Monerium just changed something material" signal,
   surface it in MPT internal monitoring, and pause new payment intents
   for a manual review window. (This is an operational suggestion, not
   a contract change.)

## Sources

### On-chain (verified directly via `https://rpc.gnosischain.com`, 2026-05-21)

- EURe proxy: <https://gnosisscan.io/address/0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430>
- EURe implementation (`GnosisControllerToken`):
  <https://gnosisscan.io/address/0x60cB9fdd0FCFd9bB3B2B721864db5E7c07F4635D#code>
- Owner Safe (3-of-6, v1.3.0):
  <https://gnosisscan.io/address/0x8001Ea269cB9715Bf7Acff89C664fFC134a519ec>
- Validator proxy (`BlacklistValidatorUpgradeable`):
  <https://gnosisscan.io/address/0xfE74A522768547bE33a3ad40b999381d57F238A0>
- Validator implementation:
  <https://gnosisscan.io/address/0x614fCC5b7f621a01731a7598e3c9645a6b0388e0>
- Monerium deployer EOA:
  <https://gnosisscan.io/address/0xc5F3370131bB7ce0D28D83735447576aAeD1b993>
- Hot minter EOA (current `SYSTEM_ROLE`):
  <https://gnosisscan.io/address/0x882145B1c33fbBC0b03875d4aBa5E5D6c84010Ef>

### Off-chain

- Monerium official repository (Apache-2.0):
  <https://github.com/monerium/smart-contracts>
- Monerium audit directory:
  <https://github.com/monerium/smart-contracts/tree/main/audits>
- Token.sol source:
  <https://github.com/monerium/smart-contracts/blob/main/src/Token.sol>
- SystemRoleUpgradeable.sol source:
  <https://github.com/monerium/smart-contracts/blob/main/src/SystemRoleUpgradeable.sol>
- BlacklistValidatorUpgradeable.sol source:
  <https://github.com/monerium/smart-contracts/blob/main/src/BlacklistValidatorUpgradeable.sol>
- Monerium dev docs (V2 contracts, currently redirects to `docs.monerium.com`):
  <https://monerium.dev/docs/contracts-v2>
- Ackee Blockchain Security audit summary (Ackee blog):
  <https://ackee.xyz/blog/monerium-audit-summary/>
- Ackee Blockchain Security audit summary (Medium mirror):
  <https://medium.com/ackee-blockchain/monerium-audit-summary-bb5178b3f837>
- USDC role architecture overview (Project Eleven write-up):
  <https://blog.projecteleven.com/posts/quantum-vs-usdc-a-threat-analysis-of-circles-smart-contract>
- Circle stablecoin contracts repo:
  <https://github.com/circlefin/stablecoin-evm>
- MakerDAO GSM Pause Delay context:
  <https://vote.makerdao.com/executive/template-executive-vote-raising-gsm-pause-delay-recognized-delegate-compensation-dai-and-mkr-streams-esm-interaction-changes-april-5-2023>
- MakerDAO Emergency Shutdown docs:
  <https://docs.makerdao.com/smart-contract-modules/shutdown/the-emergency-shutdown-process-for-multi-collateral-dai-mcd>

### Footnote anchors

[^impl-source]: Verified source on Gnosisscan, contract name
`GnosisControllerToken`, compiler `v0.8.20+commit.a1b79de6`, optimizer
enabled (200 runs):
<https://gnosisscan.io/address/0x60cB9fdd0FCFd9bB3B2B721864db5E7c07F4635D#code>.

[^uups-tradeoff]: OpenZeppelin's documentation explicitly warns that
under UUPS the upgrade logic lives in the implementation, so an
implementation deployed without `UUPSUpgradeable` (or with a buggy
`_authorizeUpgrade`) can permanently brick further upgrades. This is
mitigated by Monerium keeping `_authorizeUpgrade(...) onlyOwner`
unchanged across V2 implementations.

[^monerium-multisig]: Quoted from Monerium's official documentation as
indexed by search engines: *"The admin address corresponds to a Gnosis
MultiSig wallet, operated by Monerium's administrative personnel. They
perform daily evaluations and adjustments to the mint allowance."* The
original page (`monerium.dev/docs/contracts-v2`) currently 301-redirects
to `docs.monerium.com/tokens`, which lazy-loads addresses client-side
and was not directly fetchable; the quotation is from the indexed
snapshot returned by web search on 2026-05-21.

[^systemrole-src]: <https://github.com/monerium/smart-contracts/blob/main/src/SystemRoleUpgradeable.sol>

[^validator-source]: Verified on Gnosisscan; the proxy at
`0xfE74A5…38A0` points to implementation
`0x614fCC5b7f621a01731a7598e3c9645a6b0388e0`, which matches
`BlacklistValidatorUpgradeable.sol` in the Monerium repo.

[^audits-dir]: <https://github.com/monerium/smart-contracts/tree/main/audits>.
Commit history retrieved via
<https://github.com/monerium/smart-contracts/commits/main/audits>;
commit `ec59a36` ("Feat/v2 (#45)") on 2024-08-06 added the V2 audit
report, commit `4ac9f82` ("feat(audit): adding audit report") on
2024-03-07 added the second V1 review.

[^ackee-summary]: <https://ackee.xyz/blog/monerium-audit-summary/>.
Audit conducted 2023-06-15 to 2023-07-04 against commit `2ff1709`,
follow-ups on `3477259` and `40c7c17`. The 2-of-6 → 3-of-6 threshold
change is documented in the same write-up.

[^ackee-medium]: Medium re-post of the same summary, useful as a
secondary reference:
<https://medium.com/ackee-blockchain/monerium-audit-summary-bb5178b3f837>.

[^dai-gsm]: <https://vote.makerdao.com/executive/template-executive-vote-raising-gsm-pause-delay-recognized-delegate-compensation-dai-and-mkr-streams-esm-interaction-changes-april-5-2023>.

[^dai-es]: <https://docs.makerdao.com/smart-contract-modules/shutdown/the-emergency-shutdown-process-for-multi-collateral-dai-mcd>.

[^usdc-roles]: <https://blog.projecteleven.com/posts/quantum-vs-usdc-a-threat-analysis-of-circles-smart-contract>
provides the cleanest public summary of the
ProxyAdmin / Owner / MasterMinter / Pauser / Rescuer / Blacklister
hierarchy and notes that Circle holds the top two roles in multisigs.
