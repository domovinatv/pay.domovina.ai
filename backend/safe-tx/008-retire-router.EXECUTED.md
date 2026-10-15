# 008 — retire router: EXECUTED 2026-10-15

| | |
|---|---|
| Safe | `0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e` (2/3) |
| Tx | [`0x4c324f22f809dd0ea780c9b4f93886d62f47c4dcb0b7fc7bc0f4572f76a564b0`](https://gnosisscan.io/tx/0x4c324f22f809dd0ea780c9b4f93886d62f47c4dcb0b7fc7bc0f4572f76a564b0) |
| Block | 48775741, 2026-10-15 21:37:20 UTC |
| Batch | `008-retire-router.template.json` (both calls) |

Events in the tx:

- `AssignRoles(0xd61289c5035c6e5eaD6F100b6A8F90ac4ee054CB, [EUReForwarder], [false])` on Roles `0x3303…762c`
- `DisabledModule(0x330347d656b1a5DF972f758DE1E25E99ec36762c)` on the Safe

Verified after execution (block 48775748): `getModulesPaginated(SENTINEL, 50)` → `[]`,
`isModuleEnabled(Roles)` → `false`, `getThreshold()` → `2`.

Follow-up the same evening:

- Workers secret `ROUTER_PRIVATE_KEY` deleted from `pay-domovina-backend`.
- `tenant_rail`: `crosulja-staging` forward → direct; `router_key_enc` cleared on
  `crosulja-staging` and `italk-sandbox`. Audit rows `rail.router_retired` for `italk`,
  `crosulja-staging`, `italk-sandbox`.
- Left on-chain: router EOA `0xd612…54CB` holds ~0.60 xDAI and 0 EURe. It has no role and
  no module to act through, so the balance is only gas money; sweep it with the 1Password
  copy of the key if wanted. Chiado routers hold faucet dust (0.0009 and 0.06 xDAI).
