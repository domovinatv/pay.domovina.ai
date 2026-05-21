# Batch 002 — execution record

Reference for the first refuel of the MPT backend forwarder EOA. Executed manually via Safe Web UI ("New transaction → Send tokens → xDAI") rather than uploading the generated batch JSON; the on-chain effect is identical to what `002-fund-router-eoa.mjs --amount 1.0` would have produced.

## On-chain effect (observed 2026-05-21)

| | |
|---|---|
| Status | ✓ success |
| Network | Gnosis (chain id 100) |
| From (Safe) | `0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e` |
| To (EOA) | `0xd61289c5035c6e5eaD6F100b6A8F90ac4ee054CB` |
| Amount | 1.0 xDAI |
| Safe nonce advance | 3 → 4 |
| EOA xDAI balance change | 0.0 → 1.0 |
| Safe xDAI balance change | 1.161272 → 0.161272 |

The TX hash can be recovered from Gnosisscan address page for either Safe or EOA (filter "From: Safe, To: EOA" in the date window). Not pinned here since the user executed via UI rather than the script.

## Funding source

The 1.161272 xDAI in the Safe came from the CowSwap order that immediately preceded this refuel:

- CowSwap order: [`0x3be0064014c950f3b7dae4f046dfd1b6c9b7c0e85f570dfffc358618c476e3e0...`](https://explorer.cow.fi/gc/orders/0x3be0064014c950f3b7dae4f046dfd1b6c9b7c0e85f570dfffc358618c476e3e0449abcef4e29a7dd8d98db451af2c463561baf2e6a0efaa6)
- Settlement TX: [`0xc892e3684cc055c1353fa3e06548e22082da47ca0eadbf18b86fbd6c823ed6fb`](https://gnosisscan.io/tx/0xc892e3684cc055c1353fa3e06548e22082da47ca0eadbf18b86fbd6c823ed6fb)
- Sell: 1.0 EURe → Buy: 1.1612715886508904 native xDAI (delivered to Safe)
- Solver: `0x5fa8c6f28fc234d3b71f27913429b29091fe0f1d`
- Receiver: MPT Safe directly (CowSwap auto-unwrap of WXDAI → native xDAI via `0xEEEEee…eEEE` buyToken marker)

## Operational note: refuel cadence

At ~80k gas per `execTransactionWithRole` call and ~2 gwei on Gnosis, 1.0 xDAI = ~6000 forward TXes. Recommended cadence: monitor EOA balance via on-chain query; refuel when below 0.1 xDAI. Future automation can be a cron-driven check + Telegram alert.

## Future automation candidates

- `wrangler cron` job that polls `eth_getBalance(EOA)` every 6 hours and pings `ms-mpt-mr-signer` when below threshold
- `003-refuel-from-eure.mjs` script chaining CowSwap order placement + xDAI delivery to EOA in a single Safe batch (more complex — requires a new `EUReForwarder`-equivalent role for `WETH9.withdraw` / native send)
