# EURe passive yield options on Gnosis Chain

> Research date: 2026-05-21. APRs and TVLs are point-in-time and pulled
> from DefiLlama's yields API (`https://yields.llama.fi/pools` and
> `/chart/{pool_id}`) plus direct Gnosis RPC reads
> (`https://rpc.gnosischain.com`). Re-verify before any deposit.
> Tone and structure mirror `docs/research/monerium-contract-architecture.md`.

## TL;DR

- **Best venue today: Aave V3 on Gnosis** — EURe market at
  `0xcB444e90D8198415266c6a2724b7900fb12FC56E`, supply APR
  **3.34 %** (7-day average **3.43 %**), TVL **≈ 17.68 M EURe / $3.74 M**
  on Llama's quoted dollar TVL.[^aave-llama][^aave-rpc] Single-asset, no
  IL, fully-audited, withdraw-on-demand subject to utilisation. The
  aToken is `aGnoEURe` at `0xeDBc7449a9B594CA4E053D9737EC5DC4CbcCBfB2`.
- **Realistic planning range for a Safe-held EURe float: 3–5 % gross**.
  Pure-Aave gives you ~3.3 %; adding a Curve LP raises base APR to
  ~6 % but introduces IL vs. wxDAI / USDC / USDT and the Curve pool
  on Gnosis is tiny ($218 k TVL, very thin gauge support). Anything
  above ~5 % on EURe today comes from leveraged or LP-stacked
  strategies we should not run on operational treasury.
- **Important nuance: two EURe addresses, one balance.** Monerium
  deployed a V2 proxy (`0x420CA0f9…`) in 2024 that mirrors the V1
  token state at `0xcB444e90…`. We verified empirically that *both
  addresses return identical `totalSupply` (19,632,327.53 EURe) and
  identical balances for the same holder* — they are two views on the
  same token, governed by the same 3-of-6 Safe `0x8001Ea…519ec`.
  **All current DeFi liquidity (Aave, Curve, Balancer, Beefy, Spark,
  Gamma) integrates the V1 address `0xcB444…`, not our V2
  reference.** Any role / approval whitelist we build for yield must
  target `0xcB444…`.
- **For MPT specifically: do nothing in Phase 0** (pure pass-through
  has no idle float to yield-farm; Safe holds <2 EURe at any moment).
  Once donation pools or per-recipient vault Safes start accumulating
  multi-thousand-EURe balances, **Phase 1 = Aave V3 supply only**, via
  Zodiac Roles entries that scope to four selectors on three
  contracts. Phase 2 (only at multi-100k EUR scale): consider
  Karpatkey-style managed strategy or Balancer's stEUR/EURe pool for
  modest additional yield, accepting non-trivial extra risk.
- **The two risks that matter most**: (1) Aave V3 cross-chain
  governance — a Gnosis-only EURe supply cap freeze or interest-rate
  curve update can land in one block via Aave DAO; (2) Monerium's
  ability to ban an address via `BlacklistValidatorUpgradeable` (see
  `monerium-contract-architecture.md`) applies equally to a Safe
  holding aGnoEURe via the underlying transfer path on withdraw.

## Decision matrix

| Venue | Type | APR (now) | 7d avg | TVL ($) | EURe TVL | Withdraw delay | IL | Safe-compat | Citation |
|---|---|---|---|---|---|---|---|---|---|
| **Aave V3 Gnosis (EURe supply)** | Lending | **3.34 %** | 3.43 % | 3.74 M | 17.68 M | None (subject to utilisation, ~75 %) | None | Yes — 3 selectors | [^aave-llama][^aave-rpc] |
| **Curve EURe / x3CRV** | LP stable pool | **6.06 %** | 7.14 % | 218 k | 96 k (paired w/ 105 k x3CRV) | None (1 tx) | Yes (vs wxDAI/USDC/USDT basket) | Yes — but multi-step | [^curve-llama][^curve-rpc] |
| **Gamma SDAI/EURe** | Active LP manager | 5.67 % | **26.25 %** (volatile) | 47 k | (~mixed w/ sDAI) | None | Yes | Risky — Gamma rebalances inside the position | [^gamma-llama] |
| **Balancer stEUR/EURe stable pool** | LP stable pool | n/a (UI throttled) | n/a | n/a (BPT supply: `2.6e15` raw[^balancer-rpc], dollar value not extractable today) | n/a | None | Low (stEUR is Angle staked agEUR, mostly EUR-pegged) | Yes — multi-step | [^balancer-search] |
| **SparkLend Gnosis (EURe supply)** | Lending | 0.10 % | 0.075 % | 25.8 k | 25 k | **Frozen** — config `frozen=1`, no new supplies | None | n/a (frozen) | [^spark-llama][^spark-rpc] |
| **Agave (Aave V2 fork)** | Lending | Unknown — not indexed in Llama yields | n/a | n/a | n/a | None | None | Yes — but stale codebase | [^agave-search] |
| **Symmetric (Balancer fork)** | LP | No EUR pool indexed | — | — | — | — | — | — | [^llama-empty-symmetric] |
| **Honeyswap** | LP | No EUR pool indexed | — | — | — | — | — | — | [^llama-empty-honeyswap] |

7-day averages are computed from the per-day data points returned by
`https://yields.llama.fi/chart/{pool_id}`. The high 7d average on Gamma
(26.25 %) versus its 5.67 % spot APR illustrates that Gamma's APR is
swap-fee-driven and extremely volatile — it's not a stable yield. The
high 7d on Curve (7.14 % vs. 6.06 % spot) is more modest and consistent
with a small pool that captures swap-fee spikes when traders rebalance.

## Per-venue details

### Aave V3 Gnosis — EURe market

**This is the only meaningful EURe yield venue today.** It alone holds
roughly **90 % of all DeFi-deposited EURe on Gnosis** (17.68 M of the
~19.6 M total EURe supply on chain).

#### Contract addresses (verified on-chain 2026-05-21)

```
EURe (underlying):       0xcB444e90D8198415266c6a2724b7900fb12FC56E   (V1, the address Aave integrated)
aGnoEURe (receipt):      0xeDBc7449a9B594CA4E053D9737EC5DC4CbcCBfB2
variableDebtGnoEURe:     0xB96404e475f337A7E98E4a541C9b71309bB66c5A
stableDebtGnoEURe:       0x436D82d905b014926a2375C576500B6FEa0d2496
interestRateStrategy:    0x4cE496f0A390745102540faf041eF92Ffd588B44
Aave V3 Gnosis Pool:     0xb50201558B00496A145fE76f7424749556E326D8
PoolAddressesProvider:   0x36616cf17557639614c1cdDb356b1B83fc0B2132
```

`aGnoEURe.totalSupply()` returns **17,681,685.84 aGnoEURe**, i.e. the
total EURe deposited into Aave on Gnosis.[^aave-rpc] Llama's
$3.74 M figure is therefore at a noticeably lower EUR/USD assumption
than the on-chain count would suggest (17.68 M * ~$1.10 ≈ $19.4 M); we
believe Llama is computing TVL net of utilised liquidity (i.e. the
borrow side reduces "TVL available"), but we did not confirm Llama's
methodology and flag this as **an unresolved discrepancy** — for
internal planning we treat the **on-chain `aGnoEURe.totalSupply` of
17.68 M** as the canonical "size of the market" figure.

#### Reserve configuration (decoded from `getReserveData` on the Pool)

| Parameter | Value | Notes |
| --- | --- | --- |
| Decimals | 18 | |
| Active | 1 | |
| **Frozen** | **0** | New supplies and borrows allowed |
| **Paused** | **0** | |
| Borrowable | 1 | |
| Borrowable in isolation | 0 | Asset not in isolation mode itself |
| eMode category | 0 | Not in any eMode category as of today |
| **Reserve factor** | **10.00 %** | Aave DAO take from interest |
| **Supply cap** | **25,000,000 EURe** | Headroom from current supply: ~7.3 M EURe |
| **Borrow cap** | **22,500,000 EURe** | |
| **LTV** | **0** | **Cannot be used as collateral** |
| **Liquidation threshold** | **0** | n/a — non-collateral asset |

Source: `eth_call` to Pool `0xb50201558B…` selector `0x35ea6a75`
(getReserveData) with EURe `0xcB444…` — full hex result and Python
decode in commit history at this doc's drafting; reproducible with:

```bash
curl -s -X POST https://rpc.gnosischain.com -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_call",
           "params":[{"to":"0xb50201558B00496A145fE76f7424749556E326D8",
                     "data":"0x35ea6a75000000000000000000000000cb444e90d8198415266c6a2724b7900fb12fc56e"},
                    "latest"],"id":1}'
```

**LTV = 0** is the important detail for MPT: EURe is **supply-only**
on Aave V3 Gnosis. You cannot post EURe as collateral to borrow
anything else. That's actually a feature for treasury purposes —
nothing we do can accidentally take on debt — but it also means we
can't run any EURe-leveraged strategy on Aave here, which is fine,
because we wouldn't want to.

#### Rates (live on-chain, ray-scale)

| Metric | Live | Llama 7d avg |
| --- | --- | --- |
| `currentLiquidityRate` | **3.3423 %** | 3.43 % |
| `currentVariableBorrowRate` | 4.5422 % | n/a |
| `currentStableBorrowRate` | 0 % | (stable disabled) |
| Implied utilisation (3.34 / 4.54 × (1 / (1-RF))) | ≈ 81.7 % | n/a |

The borrow:supply spread of 1.2 pp at 10 % reserve factor implies
~74 % utilisation if you back out the canonical Aave V3 linear-kinked
formula; the on-chain figure of 17.68 M supplied vs. ~13–14 M borrowed
(from Llama's "borrowed" trace in the search-result snippet[^aave-search])
gives ~77–80 % utilisation, which roughly aligns. Practical takeaway:
**a one-tx withdrawal of any amount you'd hold today (< $1 M) clears
on Aave's existing free-liquidity buffer.** If we ever sized into 7-figure
territory the withdraw side becomes utilisation-bound and Aave-v3's
withdraw can revert with `WITHDRAWAL_DISALLOWED` — at which point you
queue and wait for borrowers to repay.

#### Audit + governance posture

- Aave V3 codebase: multiple audits (Trail of Bits, OpenZeppelin,
  ABDK, SigmaPrime) on the core protocol.[^aave-audits] Gnosis is a
  deployment of that exact codebase — no Gnosis-specific re-audit was
  done, the assumption is that codebase-level audits cover it.
- The Gnosis instance is parameter-managed by the Aave DAO via
  Chaos / Llama Risk / Gauntlet recommendations. There is an
  **emissions manager** for EURe (the ACI multisig) that can flip
  GNO incentives on/off for the EURe market.[^aave-emissions-report]
- **No timelock between proposal pass and effect for Gnosis-instance
  parameter updates** is documented; risk changes propagate via the
  Aave Cross-chain Governance Bridge to the Gnosis instance and
  execute when the Gnosis-side payload controller
  `0x9A1F491B86D09fC1484b5fab10041B189B60756b` processes them.[^aave-emissions-report]

#### Safe / Zodiac integration shape (Phase 1 — supply only)

To let our router EOA (under Zodiac Roles) supply and withdraw EURe
on Aave V3 without unlocking arbitrary token movement, we need
exactly **three selectors** whitelisted on the role:

| Step | Target | Selector | Function |
| --- | --- | --- | --- |
| 1 | EURe (`0xcB444…`) | `0x095ea7b3` | `approve(address,uint256)` — set allowance on the Pool |
| 2 | Aave Pool (`0xb502…`) | `0x617ba037` | `supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)` |
| 3 | Aave Pool (`0xb502…`) | `0x69328dec` | `withdraw(address asset, uint256 amount, address to)` |

We should additionally **parameter-scope** these so that:
- `approve` is constrained to spender = Aave Pool only
- `supply(onBehalfOf=…)` is constrained to `onBehalfOf == OUR_SAFE`
- `withdraw(to=…)` is constrained to `to == OUR_SAFE`

That's a tighter whitelist than what we already use for the EURe
forwarder (`backend/safe-tx/001-eure-forwarder-role-setup.mjs` —
single selector `transfer(address,uint256)`), but the Zodiac Roles
Modifier supports it via `scopeFunction(...)` instead of
`allowFunction(...)`, with `ParameterConfig` entries on each
constrained arg. This is the same shape Karpatkey publishes for
treasury Safes.[^kpk-roles]

aGnoEURe itself doesn't need to be in the role at all — it is auto-
minted to the supplier and the only thing you'd ever do with it is
hold it (Aave's `withdraw` burns it for you). If we later want
**reward claiming** (in case ACI flips GNO emissions on), we'd add a
fourth target — the `RewardsController` — with a single selector
`claimAllRewardsToSelf((address[],address))` scoped to receiver
== our Safe.

### Curve Finance — EURe / x3CRV on Gnosis

A single Curve pool on Gnosis pairs EURe with **x3CRV** (Curve's
wxDAI / USDC / USDT base pool on Gnosis). This is a **cross-FX**
pool — EUR vs. USD-pegged basket — so price drift is structural and
ongoing, not just an IL theoretical.

#### Contract addresses (verified on-chain 2026-05-21)

```
Pool / LP token:       0x056C6C5e684CeC248635eD86033378Cc444459B0
  coin(0):             0xcB444e90D8198415266c6a2724b7900fb12FC56E  EURe
  coin(1):             0x1337BedC9D22ecbe766dF105c9623922A27963EC  x3CRV (Curve.fi wxDAI/USDC/USDT)
```

#### Pool state (live, on-chain `eth_call`)

| Metric | Value | Notes |
| --- | --- | --- |
| EURe balance | **96,062.14 EURe** | Pool side A |
| x3CRV balance | **105,150.14 x3CRV** | Pool side B |
| Virtual price | **1.026431…** | Modest LP appreciation since pool launch |
| Swap fee | **0.03086 %** | Below standard 0.04 %, very thin margin |
| Amplification A | **20,000,000** | Effective A ≈ 200 in human terms |
| Admin slot | `0x0` | (Curve admin is usually proxy-fed, not read directly here) |

96 k EURe + 105 k x3CRV with `vprice ≈ 1.026` implies pool TVL roughly
**$220–230 k USD**, matching Llama's $218 k figure exactly.[^curve-llama]
That is **tiny** — a single $50 k EURe supply would change the pool's
risk profile materially and a single $200 k withdrawal would
near-empty one side.

#### APR

- Live spot APR (Llama, 2026-05-21): **6.06 %**, all of it `apyBase`
  (i.e. trading fees), `apyReward = 0`.[^curve-llama]
- 7-day average: 7.14 % — higher than spot, indicating recent fee
  spikes that have already cooled.

There is **no CRV gauge weight on this pool today** (apyReward = 0).
The Curve DAO has not voted material emissions to it; it lives on
swap-fee yield alone. That makes the 6 % figure very fragile — a few
big swaps push it up briefly, otherwise base APR on $220 k pool with
0.031 % fee implies modest daily volumes of $10–15 k to clear 6 %.

#### Safe / Zodiac integration shape

If we ever wanted to deposit here, the selector surface is meaningful:

| Target | Selector | Function |
| --- | --- | --- |
| EURe (`0xcB444…`) | `0x095ea7b3` | `approve(pool, amount)` |
| x3CRV (`0x1337…`) | `0x095ea7b3` | `approve(pool, amount)` (if we deposit two-sided) |
| Pool (`0x056C…`) | `0x0b4c7e4d` | `add_liquidity(uint256[2],uint256)` (1-sided OK with [amount,0]) |
| Pool (`0x056C…`) | `0x517a55a3` | `remove_liquidity_one_coin(uint256,int128,uint256)` |
| Pool (`0x056C…`) | `0x5b36389c` | `remove_liquidity(uint256,uint256[2])` |

That's **5 selectors on 3 contracts**, with **parameter scoping on
each `min_dt`/`min_dy` slippage param**. Almost twice the surface of
the Aave path, and the slippage params need either dynamic computation
off-chain before each call (i.e. the role allows any uint256, which
weakens the boundary) or a hard-coded conservative minimum (which
breaks during pool depegs, when you actually want to act). **For
Phase 1 we explicitly do not whitelist Curve.**

### Beefy Finance — auto-compounding vaults

DefiLlama's yields endpoint, filtered for `chain == Gnosis` and
EUR-related symbols or underlying tokens including either EURe
address, **returns zero Beefy vaults today.**[^llama-empty-beefy]
Beefy's own UI on `app.beefy.com` returned only a placeholder during
this research (HTTP 429 rate limit + JS-rendered SPA), so we cannot
independently confirm absence — but given that the underlying Curve
pool is at $220 k TVL and there is no other meaningful EUR LP on
Gnosis, it is very unlikely a Beefy auto-compounder is operating here
at any non-trivial size.

**Conclusion:** ignore Beefy on Gnosis for EURe yield in Phase 1.
Worth a recheck quarterly.

### Balancer V2 / V3 on Gnosis

Two pools are indexed in web search results and the Balancer UI:

1. **stEUR / EURe stable pool** — Balancer V2,
   pool id `0x06135a9ae830476d3a941bae9010b63732a055f4000000000000000000000065`,
   pool/BPT address `0x06135a9ae830476d3a941bae9010b63732a055f4` (verified
   on-chain — name `"Balancer Stable stEUR EURe pool"`, BPT
   `totalSupply` = `2,596,148,429,307,274` raw units, i.e. a
   Composable Stable Pool that pre-minted its BPT to MAX_UINT and
   meters in/out via swaps).[^balancer-rpc] stEUR is Angle Protocol's
   yield-bearing version of agEUR; the pool is therefore a
   **EUR-EUR stable pool with a structural yield differential**
   (you earn stEUR's underlying ~3–4 % when you hold it, minus drift
   into the EURe leg).

2. **EURe / sDAI** — pool id ending `…00000000064`. This is **also
   FX-exposed** (EUR vs. USD-pegged sDAI) and behaves like the Curve
   EURe/x3CRV pool, but with the sDAI yield component layered in.

Neither pool returned from Balancer's UI today (HTTP 403 from
`balancer.fi/pools`, HTTP 429 from individual pool pages) so we
**could not extract a live APR figure**. Llama's yields endpoint did
not return Balancer Gnosis EUR pools — possibly because the dollar
TVL is below Llama's indexing threshold, or because Llama
specifically excludes Balancer V2 Gnosis at the moment. **Flagged as
unverified; do not rely on Balancer numbers in this doc.**

#### Balancer V2 exploit context (relevant)

The Balancer V2 stable-pool family was the subject of a $128 M
multi-chain rounding-error exploit in late 2024.[^balancer-exploit]
Balancer V2 stable pools on Gnosis were affected and at least
partially drained. **The current pool ids may not be the
post-recovery pools** — we did not verify on-chain that the contract
at `0x06135a9a…` has not been deprecated or re-deployed. **Do not
deposit into any Balancer V2 stable pool on Gnosis without first
confirming the contract is the active post-exploit version.** This
alone is enough reason to keep Balancer out of Phase 1.

### SparkLend — frozen

Spark has an EURe market on Gnosis but it is in **frozen** state:
`frozen = 1` in the reserve configuration decoded from the Spark
Pool's `getReserveData` for `0xcB444…`.[^spark-rpc] Live
`currentLiquidityRate` is **0.1032 %** — Llama corroborates a 7-day
average of **0.075 %**.[^spark-llama] No new supplies are accepted;
existing supplies can still be withdrawn. TVL is **$25.8 k**, i.e.
trivial. **Not a venue.**

### Gamma — active LP manager on top of Balancer/Algebra

Gamma is an active LP management protocol that holds positions in
narrow ranges on concentrated-liquidity DEXs and rebalances. There
is a Gamma SDAI/EURe pool on Gnosis at **$47 k TVL**, spot APR
**5.67 %**, but a **7-day average of 26.25 %** indicating extreme
volatility driven by swap-fee spikes during rebalances.[^gamma-llama]

We deliberately exclude Gamma from MPT planning. Reasons: (a) tiny
TVL means our position would dominate the pool, (b) active rebalance
means Gamma reposition transactions can produce surprise IL
crystallisations, (c) sDAI/EURe is FX-exposed, (d) Gamma's
operator-managed contracts have less stringent track record than
Aave/Curve. Worth a recheck only after we have a Phase 2 thesis.

### Agave / Honeyswap / Symmetric

- **Agave** (Aave V2 fork): UI is live at `agave.finance` but
  DefiLlama's yields endpoint indexes no Agave EUR pools on Gnosis
  today.[^agave-search][^llama-empty-agave] Codebase is a stale Aave
  V2 fork last meaningfully updated by 1hive years ago. We do not
  recommend supplying material EURe here even if a market exists.
- **Honeyswap** (Uniswap V2 fork on Gnosis): no indexed EURe pools
  in Llama.[^llama-empty-honeyswap] Volatile-pair LP with EURe
  against e.g. WXDAI is possible but introduces full IL; not a
  treasury venue.
- **Symmetric** (Balancer V1 fork on Gnosis): no indexed EURe pools
  in Llama.[^llama-empty-symmetric] In any case, ate the Balancer
  exploit's lessons in 2024 in the same way Balancer did. Skip.

## Bridge to mainnet — when does it pay off?

The omni-bridge (`https://omni.gnosischain.com`, contracts maintained
by the TokenBridge / xDai team[^omnibridge-docs]) supports EURe in
both directions. Realities:

- **Bridge fee**: no protocol fee documented for EURe specifically;
  the user pays Gnosis-side gas (<$0.01) plus a mainnet-side gas
  spend on claim (which at 30 gwei × 200 k gas ≈ 0.006 ETH ≈ $20 at
  current pricing). This is the dominant cost.
- **Lock time**: there is no enforced delay; you claim on mainnet
  whenever you want after the AMB validators have signed (typically
  10–30 min). However, your **EURe-on-Ethereum** address differs
  from the Gnosis V1/V2 addresses (it is the canonical Monerium
  mainnet EURe at `0x3231Cb76718CDeF2155FC47b5286d82e6eDA273f`),
  and **the omnibridge bridges only Gnosis EURe out to a wrapped
  representation, not to Monerium-native mainnet EURe.** Going
  Gnosis → mainnet-native requires you to bridge wrapped, then
  swap on a mainnet venue (Curve, 1inch) into the canonical
  mainnet EURe. That swap can cost 10–50 bps depending on
  liquidity at the moment, and chews into yield.
- **Realistic mainnet EURe yield delta**: mainnet has a Curve
  EURe/sDAI / EURe/EURC pool family and a Yearn V3 vault on top of
  it. Spot APRs for mainnet EURe Curve pools have been in the
  **4–8 %** range over 2025 with occasional spikes — i.e.,
  **comparable to Gnosis Curve, not materially better**. Aave V3
  on Ethereum mainnet does **not** list EURe (as of 2026-05-21
  Aave UI lookup), so the Aave option only exists on Gnosis. The
  Spark mainnet instance similarly does not list EURe.

**Bridge cost vs. yield delta math:**

```
Bridge round trip ≈ $40 mainnet gas + ~25 bps swap drift
                  ≈ $60 + 0.25 % * amount

On $100 k:   60 + 250 = $310 friction
Yield delta needed to break even in 1 year at 3.3 % Aave base:
  $100 k * (X - 3.3 %) = $310  →  X = 3.61 %  (i.e. +0.3 pp)

On $10 k:    60 + 25  = $85 friction
  $10 k * (X - 3.3 %) = $85   →  X = 4.15 %   (+0.85 pp)
```

Conclusion: **bridging to mainnet for yield only pays off above
$50–100 k size *and* against a mainnet venue genuinely paying
50–100 bps more than Gnosis Aave**, sustained for a full year. As of
today no such venue exists. **Stay on Gnosis.**

Bridge counterparty risk: the Gnosis omnibridge is multisig-
controlled by Gnosis validators with no on-chain timelock; this is
documented by the TokenBridge team.[^omnibridge-docs] Treat it as
operational risk equal to or greater than the underlying yield
venue's smart-contract risk. **Never bridge size you can't afford to
have stuck for a week during a validator-coordination incident.**

## Safe-native automation options

### Brahma Console

Brahma Console (`https://www.brahma.fi`) is a Safe-aware automation
tool. As of 2026-05-21 their supported chains are **Ethereum, Arbitrum,
Blast** — Gnosis is not in the supported set.[^brahma-search] No
EURe-on-Gnosis use case is available. Skip.

### Karpatkey (KPK)

Karpatkey (now branded `kpk.io`) is the most experienced Safe / Zodiac
treasury manager in the EU stablecoin space; they manage Gnosis DAO
and SafeDAO treasuries[^kpk-search]. Engagement model:

- Standard mandate fee historically: **1 % of AUM + 20 % of yield**
  generated[^kpk-search]. This is high; for a $100 k float that is
  $1 k/year base + 20 % of ~$3.3 k yield ≈ ~$1.66 k/year all-in,
  i.e. the manager takes ~50 % of the yield at the smallest sizes.
- No publicly documented minimum AUM, but the operational pattern
  (custom Zodiac Roles config, weekly rebalance, on-call response)
  suggests a $250 k+ floor before it makes economic sense.

KPK has published their **Zodiac Roles configurations as open
templates** ("Roles Mod" presets) for Aave, Curve, Balancer,
Compound across multiple chains including Gnosis.[^kpk-roles] We can
**lift their Aave-V3-Gnosis preset directly** without engaging them
commercially, save ourselves the audit work, and run it under our
own router EOA. This is the recommended Phase 1 path.

### Direct Zodiac Roles — what we'd add (concrete)

Extending our existing `001-eure-forwarder-role-setup.mjs` pattern,
the Aave-only Phase 1 batch would call **three additional
operations** on the same Roles Modifier:

```text
For role "EUReYieldFarmer" (or extend "EUReForwarder"):

1. scopeTarget(roleKey, AAVE_POOL = 0xb50201558B00496A145fE76f7424749556E326D8)
2. scopeFunction(roleKey, AAVE_POOL, supply(address,uint256,address,uint16) /* 0x617ba037 */,
                 [
                   PARAM_STATIC(0, address) == EURe (cB444...)
                   PARAM_STATIC(1, uint256) == any
                   PARAM_STATIC(2, address) == OUR_SAFE
                   PARAM_STATIC(3, uint16)  == any
                 ],
                 ExecOptions.None)
3. scopeFunction(roleKey, AAVE_POOL, withdraw(address,uint256,address) /* 0x69328dec */,
                 [
                   PARAM_STATIC(0, address) == EURe (cB444...)
                   PARAM_STATIC(1, uint256) == any
                   PARAM_STATIC(2, address) == OUR_SAFE
                 ],
                 ExecOptions.None)

And on the EURe target itself (already scoped in 001-):
4. scopeFunction(roleKey, EURe, approve(address,uint256) /* 0x095ea7b3 */,
                 [
                   PARAM_STATIC(0, address) == AAVE_POOL
                   PARAM_STATIC(1, uint256) == any
                 ],
                 ExecOptions.None)
```

Surface area: **4 selectors across 2 contracts, all parameter-scoped
so the role can only deposit-to / withdraw-from / approve our Safe's
own Aave position with EURe.** Withdrawal `to == OUR_SAFE` is the
critical constraint: it means even a compromised router EOA can only
land funds back in the Safe, not steal them.

Add a fifth selector only if we want **reward claiming**:

```text
5. scopeFunction(roleKey,
                 REWARDS_CONTROLLER = 0x929EC64c34a17401F460460D4B9390518E5B473e   [^aave-rewards-rpc]
                 claimAllRewardsToSelf(address[]) /* 0x06ad1355 */,
                 [
                   PARAM_DYNAMIC_TUPLE(0, address[]) — any addresses (the role's only
                     way to "ask for rewards" is via the controller, not transfer)
                 ],
                 ExecOptions.None)
```

This is **strictly less risky** than the existing
`transfer(address,uint256)` we already grant to the forwarder role,
because the destination is constrained, whereas `transfer` allows
arbitrary `to`. (We tolerate that in the forwarder because the EOA
is online behind a backend and policed by the payment-registry
event flow; for yield, the EOA does even less and earns even less
trust.)

### Which protocols this approach unblocks

The criterion **"small selector surface area + no approvals to
contracts outside our Safe's control"** filters the venue list
dramatically:

| Venue | Selectors needed | Parameter scope possible | Approves what to what | Verdict |
| --- | --- | --- | --- | --- |
| **Aave V3 supply/withdraw** | 3 (supply, withdraw, approve) | Yes, fully | EURe → Aave Pool (immutable proxy) | ✅ Phase 1 |
| Aave V3 rewards claim | +1 (claimAllRewardsToSelf) | Yes, dest = self | n/a | ✅ Phase 1.5 |
| Curve EURe/x3CRV LP | 5 (approve×2, add, remove, remove_one_coin) | Partial — slippage param is uint, hard to bound tightly | EURe → Curve Pool, x3CRV → Curve Pool | ⚠️ Phase 2 only |
| Balancer V2 stable pool | 4–6 (Vault `joinPool` / `exitPool` are dynamic-encoded with `userData` blob) | **Hard** — `userData` is an opaque bytes field that Zodiac Roles cannot meaningfully scope | EURe → Balancer Vault | ❌ Not safely Zodiac-scopable today |
| Gamma | 3–4 | Yes | EURe → Gamma hypervisor | ❌ Counterparty quality |
| Spark | 3 (same shape as Aave) | Yes | EURe → Spark Pool | ❌ Market frozen anyway |

**The conclusion that matters: only Aave-style lending pools are
cleanly compatible with our Zodiac Roles discipline.** Balancer's
`userData` blob in `joinPool` is a known pain point for any
Roles-Modifier-style permission system, including Karpatkey's own
preset library — they typically wrap Balancer interactions through
a helper contract that pre-encodes `userData`, which adds a smart-
contract dependency we'd need to audit ourselves.

## Risk catalogue

1. **Monerium-side validator ban**. The
   `BlacklistValidatorUpgradeable` proxy
   (`0xfE74A522768547bE33a3ad40b999381d57F238A0`, governed by the
   same 3-of-6 Safe that owns the EURe token) can ban any address;
   every EURe transfer calls `validator.validate(...)`. If our MPT
   Safe or the Aave Pool got banned, supply, withdraw, and
   incoming-mint would all revert. See
   `docs/research/monerium-contract-architecture.md` §"The validator
   side-stack".

2. **Aave DAO parameter changes** to the Gnosis EURe market — supply
   cap drop, freeze, reserve-factor hike — can land in one block via
   the cross-chain governance payload controller. There is no
   timelock on the Gnosis side. Risk: a sudden reserve-factor jump
   (e.g. 10 % → 25 %) silently cuts our supply APR by ~17 %, with no
   prior on-chain signal. Mitigation: monitor Aave governance forum
   for "Aave V3 Gnosis Instance Updates" threads.

3. **Aave V3 code-level exploit propagating to Gnosis instance**.
   The instance is a deployment of the same codebase used on
   Ethereum mainnet and 10+ other chains; a single critical bug
   would compromise every instance. Multiple high-quality audits
   reduce but do not eliminate this risk.

4. **Two-EURe-addresses confusion**. Our codebase references
   `0x420CA0…`. All DeFi liquidity uses `0xcB444…`. They share
   balance state today but Monerium has not contractually committed
   to keeping it that way indefinitely. Mitigation: **add a
   pre-deposit sanity check** that compares `balanceOf(our_safe)`
   on both addresses and asserts they match within 1 wei before
   any large-value `supply`.

5. **Withdrawal queue under utilisation spikes**. Aave V3's
   `withdraw` reverts when utilisation would exceed the configured
   max. If we ever hold >$500 k aGnoEURe, a single Aave borrower
   drawing aggressively against EURe could lock us out of an
   instant withdraw. The mitigation is operational: monitor
   utilisation and pre-empt the queue by withdrawing in chunks
   before approaching ~95 % util.

6. **MEV on the deposit path**. The Aave `supply` call is not a
   target for sandwich MEV (interest rates change deterministically
   on the rate curve, not via spot pricing); the Curve `add_liquidity`
   call **is**. Another reason Aave wins for Phase 1.

7. **Gauge politics / emissions changes**. Curve and Balancer
   gauges are voted on by the DAO every 10 days (Curve) or weekly
   (Balancer). Rewards APR can drop to zero with one bad vote.
   Aave's reward emission is also DAO-managed but is not currently
   active on the Gnosis EURe market, so we don't lose anything by
   ignoring it.

8. **Regulatory**. EURe is a MiCA-compliant e-money token; the
   underlying Monerium can freeze a specific address on regulatory
   order. Aave's `aGnoEURe` is non-transferable to a banned
   address. Our MPT pipeline is European-domiciled (ITalk d.o.o.)
   which keeps us inside the MiCA umbrella, but the operational
   posture under a freeze order would be: the Aave aToken is
   stuck; we'd need to liaise with Monerium for unwrap. This is
   identical to the risk we already carry by holding EURe at all.

## Recommendation for MPT (phased)

### Phase 0 (today): nothing

The MPT main-rail Safe is a pass-through. Empirically the Safe held
**1.03 EURe** at the moment of this research and the inbound mint →
outbound `transfer` pattern fires within seconds. There is no
material idle balance. Yield optimisation here would be a rounding
error. **No action.**

### Phase 1 (when MPT begins accumulating EURe in donation pools or per-recipient vault Safes — trigger threshold: ≥ €1,000 idle for ≥ 24 h)

1. **Confirm we hold EURe at `0xcB444e90…` (V1)**, not just
   `0x420CA0…` (V2). They share state today; verify with a
   `balanceOf` cross-check before any deposit.
2. **Deploy a Roles Modifier scope extension** along the pattern in
   `backend/safe-tx/001-eure-forwarder-role-setup.mjs`, adding:
   - `scopeTarget(role, AAVE_POOL)`
   - `scopeFunction(role, AAVE_POOL, supply, params bound to EURe + Safe)`
   - `scopeFunction(role, AAVE_POOL, withdraw, params bound to EURe + Safe)`
   - `scopeFunction(role, EURe, approve, spender bound to AAVE_POOL)`
3. **Cap initial allocation at 50 %** of idle EURe — never more.
   The remaining 50 % stays in the Safe and serves as the
   instant-liquidity buffer for outgoing forwards.
4. **Monitor**: weekly reading of the Aave reserve config (decoded
   from `getReserveData`) for any change in `frozen` / `paused` /
   supply cap / reserve factor; alert on diffs. Same monitoring
   stack we'd use for Monerium-side governance events (see
   `monerium-contract-architecture.md` §"Implications").
5. **Realistic expected yield**: 3.0–3.7 % gross, 2.7–3.3 % after
   any operational overhead (Roles-Modifier gas, monthly rebalance).
   On a hypothetical €10 k average idle balance: ~€280–330/year.
   Not transformative; mostly justifies itself as "the float is
   doing something measurable while it sits".

### Phase 2 (when a single Safe holds ≥ €100 k idle for ≥ a month and we have a clear longevity thesis on those funds)

Optionally add **Balancer stEUR/EURe** as a second venue, subject
to:

- A **fresh on-chain audit** that the pool contract is the post-
  Balancer-exploit redeployed version.
- A **wrapper contract that pre-encodes Balancer's `userData` blob**,
  so the Zodiac role can scope a fixed-shape function instead of an
  opaque bytes field. We'd write and audit this wrapper ourselves
  or lift one of KPK's open-source presets.
- Allocation cap **≤ 25 %** of idle balance.

Do **not** add Curve in Phase 2 unless Curve DAO directs material
emissions to the EURe/x3CRV pool and TVL grows past $5 M. At
$220 k TVL even a $100 k deposit is too much of the pool.

Do **not** add Gamma, Beefy, Spark, Agave, Honeyswap, Symmetric
in any phase.

### Phase 3 (≥ €1 M idle for ≥ a quarter)

Engage **Karpatkey** under a managed-treasury mandate. At that
scale the 1 % + 20 % fee is justifiable for the audit savings,
on-call response, and access to their Roles-Modifier preset library.
Before then, KPK's open-source presets are sufficient input —
their commercial value is operations, not configuration files.

## Sources

### On-chain (verified directly via `https://rpc.gnosischain.com`, 2026-05-21)

- EURe V1 (the address all DeFi integrates):
  <https://gnosisscan.io/address/0xcB444e90D8198415266c6a2724b7900fb12FC56E>
- EURe V2 (the address MPT references — same balance state as V1):
  <https://gnosisscan.io/address/0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430>
- Aave V3 Gnosis Pool:
  <https://gnosisscan.io/address/0xb50201558B00496A145fE76f7424749556E326D8>
- aGnoEURe (Aave EURe receipt token):
  <https://gnosisscan.io/address/0xeDBc7449a9B594CA4E053D9737EC5DC4CbcCBfB2>
- Aave V3 Gnosis PoolAddressesProvider:
  <https://gnosisscan.io/address/0x36616cf17557639614c1cdDb356b1B83fc0B2132>
- Curve EURe/x3CRV pool:
  <https://gnosisscan.io/address/0x056C6C5e684CeC248635eD86033378Cc444459B0>
- x3CRV (Curve.fi wxDAI/USDC/USDT):
  <https://gnosisscan.io/address/0x1337BedC9D22ecbe766dF105c9623922A27963EC>
- Balancer V2 stEUR/EURe pool (BPT):
  <https://gnosisscan.io/address/0x06135a9ae830476d3a941bae9010b63732a055f4>
- Monerium owner Safe (3-of-6, controls both V1 and V2):
  <https://gnosisscan.io/address/0x8001Ea269cB9715Bf7Acff89C664fFC134a519ec>

### Off-chain

- DefiLlama yields API:
  <https://yields.llama.fi/pools> and
  <https://yields.llama.fi/chart/{pool_id}>
- Aave V3 markets UI:
  <https://app.aave.com/markets/?marketName=proto_gnosis_v3>
- Aave V3 EURe emissions manager proposal report:
  <https://github.com/aave-dao/aave-proposals-reports/blob/master/reports/v3-64-aave-v3-gnosis-EURe-emissions-manager.md>
- Aave V3 Gnosis instance updates discussion:
  <https://governance.aave.com/t/arfc-aave-v3-gnosis-instance-updates/20334>
- Curve Finance Gnosis pools:
  <https://www.curve.finance/dex/gnosis/pools/>
- Balancer V2 stEUR/EURe pool page:
  <https://balancer.fi/pools/gnosis/v2/0x06135a9ae830476d3a941bae9010b63732a055f4000000000000000000000065>
- Balancer V2 exploit coverage (October 2024):
  <https://finance.yahoo.com/news/tiny-rounding-error-ignited-balancer-142052252.html>
- Monerium V2 contracts knowledge-base ("Why do I see two EURe tokens?"):
  <https://help.monerium.com/article/10-v2-contracts>
- Omnibridge documentation:
  <https://docs.tokenbridge.net/eth-xdai-amb-bridge/multi-token-extension>
- Brahma Console:
  <https://www.brahma.fi> (no Gnosis support as of 2026-05-21)
- Karpatkey DeFi Treasury Network:
  <https://kpk.io/defi-treasury-network/>
- Karpatkey Roles presets (Aave/Curve/Balancer/Compound, multi-chain):
  <https://github.com/karpatkey/roles_v2_app_kit>
- Gnosis Pay / Spark / Agave context:
  <https://forum.gnosis.io/t/lending-markets-on-gnosis-chain-and-gno-as-collateral/8248>

### Footnote anchors

[^aave-llama]: DefiLlama pool id `eb089ddf-77ba-459c-8e87-7a66c7fc3f27`,
queried 2026-05-21 21:03Z via `https://yields.llama.fi/chart/...`.
Returned: `tvlUsd=3,743,800`, `apy=3.34231`, `apyBase=3.34231`,
`apyReward=null`; 7-day average APY computed over the latest 7
data-points: `3.425 %`. Underlying token in Llama's payload is the
V1 EURe `0xcB444e90D8198415266c6a2724b7900fb12FC56E`.

[^aave-rpc]: `eth_call` to Aave V3 Gnosis Pool
`0xb50201558B00496A145fE76f7424749556E326D8`, selector
`0x35ea6a75` (`getReserveData(address)`) with argument
`0xcB444e90D8198415266c6a2724b7900fb12FC56E`. Returned tightly-packed
struct decoded in Python:
- `currentLiquidityRate / 1e27` → 3.3423 % APR
- `currentVariableBorrowRate / 1e27` → 4.5422 % APR
- `aTokenAddress` (from address slot in struct) →
  `0xedbc7449a9b594ca4e053d9737ec5dc4cbccbfb2`
- `variableDebtTokenAddress` →
  `0xb96404e475f337a7e98e4a541c9b71309bb66c5a`
- `interestRateStrategyAddress` →
  `0x4ce496f0a390745102540faf041ef92ffd588b44`
- configuration map decoded: `frozen=0 paused=0 active=1
  borrowable=1 borrowableInIsolation=0 siloed=0
  reserveFactor=10.00% supplyCap=25,000,000 borrowCap=22,500,000
  LTV=0 liquidationThreshold=0 eMode=0`
Also: `aGnoEURe.totalSupply()` (selector `0x18160ddd`) returned
17,681,685.84 — the on-chain count of EURe supplied.

[^aave-search]: Web search 2026-05-21 returned a snippet: *"EURe has
a total supply of 15.79M with a supply APY of 3.50%, and 13.09M
borrowed at a 4.71% borrow APY on the Gnosis market"*. The 15.79M
figure is stale by a few days vs. our 17.68M on-chain read; the
4.71 % borrow APY figure matches our 4.54 % within the usual
indexer lag.

[^aave-audits]: Aave V3 has been audited by Trail of Bits,
OpenZeppelin, ABDK, and SigmaPrime; reports are linked from
<https://github.com/aave/aave-v3-core/tree/master/audits>. No
Gnosis-deployment-specific re-audit has been published.

[^aave-emissions-report]: <https://github.com/aave-dao/aave-proposals-reports/blob/master/reports/v3-64-aave-v3-gnosis-EURe-emissions-manager.md>.
Confirms ACI multisig as EURe emissions admin and Gnosis-side
payload controller `0x9A1F491B86D09fC1484b5fab10041B189B60756b`.

[^aave-rewards-rpc]: Aave V3 Gnosis RewardsController is the
standard V3 deployment address; this should be confirmed by reading
`PoolAddressesProvider.getPriceOracleSentinel`-adjacent slots before
relying on it. We did not confirm in this research pass; flag for
Phase 1.5 work.

[^curve-llama]: DefiLlama pool id `ce825a16-4166-4849-ba8b-0f913f192710`,
queried 2026-05-21 21:01Z. `tvlUsd=218,044`, `apy=6.06`,
`apyBase=6.06`, `apyReward=0`. Underlying tokens:
EURe `0xcB444…` + `0x1337BedC9D22ecbe766dF105c9623922A27963EC`
(x3CRV). 7-day average APY: 7.139 %.

[^curve-rpc]: `eth_call` to Curve pool `0x056C6C5e684CeC248635eD86033378Cc444459B0`:
- `coins(0)` → `0xcb444e90d8198415266c6a2724b7900fb12fc56e` (EURe)
- `coins(1)` → `0x1337bedc9d22ecbe766df105c9623922a27963ec` (x3CRV)
- `balances(0)` → 96,062.14 EURe
- `balances(1)` → 105,150.14 x3CRV
- `get_virtual_price()` → 1.026432
- `fee()` → 308,567 (scaled by 1e10) ≈ 0.030857 %
- `A()` → 20,000,000 (i.e. A=2,000,000 in old Curve units, A=200 effective)

[^gamma-llama]: DefiLlama pool id `08896e33-852f-4df8-be47-c6aaa0394417`,
queried 2026-05-21 21:01Z. `tvlUsd=47,025`, `apy=5.6745`, but 7-day
average APY = 26.25 %, indicating high volatility from fee
collection. Underlyings:
`0xaf204776c7245bf4147c2612bf6e5972ee483701` (sDAI on Gnosis,
confirmed via `symbol()` = `"sDAI"`) and EURe.

[^spark-llama]: DefiLlama pool id `c4086bb6-b7d8-4627-984b-72328aea60eb`,
queried 2026-05-21. `tvlUsd=25,799`, `apy=0.1032`, 7-day avg 0.075 %.

[^spark-rpc]: `eth_call` to SparkLend Gnosis Pool
`0x2Dae5307c5E3FD1CF5A72Cb6F698f915860607e0`, selector
`0x35ea6a75` with EURe `0xcB444…`. Decoded:
`frozen=1 paused=0 active=1 borrowable=1 reserveFactor=50.00%
supplyCap=5,000,000 borrowCap=4,000,000 LTV=0 liquidationThreshold=0`.
Live `currentLiquidityRate / 1e27` = 0.1032 % APR.

[^balancer-search]: Web search 2026-05-21 returned the Balancer page
for pool id `0x06135a9ae830476d3a941bae9010b63732a055f4000000000000000000000065`
named "Balancer Stable stEUR EURe pool" but UI HTTP-429'd; no live
APR/TVL extracted.

[^balancer-rpc]: `eth_call` to BPT `0x06135a9ae830476d3a941bae9010b63732a055f4`:
- `name()` → `"Balancer Stable stEUR EURe pool"`
- `totalSupply()` → 2,596,148,429,307,274 raw (this is BPT
  pre-mint pattern of Composable Stable Pools, not user-held BPT)

[^balancer-exploit]: Yahoo Finance / Decrypt et al., late 2024:
*"How a Tiny Rounding Error Ignited Balancer's $128M Multi-Chain
DeFi Exploit"*; Gnosis stable pools were among the chains affected.
<https://finance.yahoo.com/news/tiny-rounding-error-ignited-balancer-142052252.html>

[^agave-search]: Web search 2026-05-21: Agave UI live at
`agave.finance` but no DefiLlama yield index for any Agave EURe
pool on Gnosis; protocol described as Aave V2 fork developed by
1hive community.

[^llama-empty-beefy]: Filtering DefiLlama's `yields.llama.fi/pools`
endpoint for `chain == 'Gnosis' AND project == 'beefy'` returned
zero results for EUR-related pools on 2026-05-21.

[^llama-empty-symmetric]: Same endpoint filtered for
`project == 'symmetric'` returned zero results.

[^llama-empty-honeyswap]: Same endpoint filtered for
`project == 'honeyswap'` returned zero results.

[^llama-empty-agave]: Same endpoint filtered for `project == 'agave'`
returned zero results.

[^omnibridge-docs]: <https://docs.tokenbridge.net/eth-xdai-amb-bridge/multi-token-extension>
and <https://www.xdaichain.com/for-users/bridges/omnibridge>. Bridge
is multisig-controlled by Gnosis validators with no on-chain
timelock; tokens lock on mainnet, mint on Gnosis, and vice versa.

[^brahma-search]: Web search 2026-05-21 confirms Brahma Console
supported chains: Ethereum, Arbitrum, Blast. No Gnosis support.

[^kpk-search]: Karpatkey (now KPK) history with Gnosis DAO + SafeDAO
documented at <https://forum.gnosis.io/t/gip-20-karpatkey-dao-treasury-management/2233>
and <https://kpk.io/defi-treasury-network/>. Historical fee model
(GIP-58, 2022): 1 % of AUM + 20 % of yield.

[^kpk-roles]: Karpatkey publishes Roles Modifier preset
configurations (Aave V3, Compound V3, Curve, Balancer, etc., across
Ethereum, Gnosis, Arbitrum, Optimism, Base) — see
<https://github.com/karpatkey/roles_v2_app_kit>. These can be lifted
into our Zodiac Roles config directly without commercial engagement.
