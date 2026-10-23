# ADR 0031 — Vlastiti Gnosis RPC (`acutis`) za čitanja na serveru, javni RPC kao rezerva

- **Status:** Accepted, korak 1 implementiran 2026-10-23 (`backend/src/chain/gnosisRpc.ts`)
- **Kontekst:** MPT rail (`backend/`), sva čitanja lanca Gnosis (100) iz Workera
- **Gradi na:** [0030](0030-edge-cache-javnog-citanja.md)
- **Čvor:** repo `domovina-gnosis-node`: Nethermind + Lighthouse na i9 (`acutis`), izložen kao
  `https://acutis-rpc.mpt.hr` kroz Cloudflare Tunnel, iza Cloudflare Accessa (aplikacija
  `acutis-rpc`, Service Auth samo za token `eure-reader`)
- **Odluka vlasnika:** Matija Stepanic, 23. 10. 2026.

## Problem

Rail čita lanac na mnogo mjesta: provjere role i salda prije forwarda, cron indexer uplata,
outflow watch, potvrde potpisa računa i `balanceOf` za `/api/activity`. Sve to ide na
`rpc.gnosischain.com`. Javni RPC ima ograničenja po IP-u i raspone `eth_getLogs` od nekoliko
tisuća blokova, a ne znamo kada se mijenja ni kada pada. Zato smo podigli vlastiti čvor.

## Odluka

1. Sva **čitanja** na serveru za Gnosis idu kroz `readTransport(env, chain, rpcUrl)` (za viem)
   ili `gnosisRpc(env, rpcUrl)` (za sirovi JSON-RPC):
   - prvo `ACUTIS_RPC_URL` sa zaglavljima `CF-Access-Client-Id`/`-Secret`, uz timeout od 4 s;
   - zatim javni `rpcUrl` ako čvor ne odgovori, vrati ne-JSON (Access 403), odbije metodu
     ili raspon, ili javi `eth_syncing ≠ false`;
   - revert (`code 3`, `-32015`, „revert”) se prosljeđuje i ne ponavlja na rezervi, jer je isti
     na svakom čvoru.
2. Zdravlje čvora (`eth_syncing`) provjerava se najviše jednom u 60 s po izolatu. Čvor koji
   padne preskače se do isteka tog razdoblja.
3. Bez secreta `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` ponašanje je isto kao prije.
   Chiado nema vlastiti čvor i uvijek ide na `rpcUrl`.
4. `rail.rpcUrl` ostaje javni URL. Setup dapp ga stavlja u CSP i zove iz preglednika, a
   preglednik nikad ne smije dobiti Access token.

## Što namjerno nije prebačeno

- **Pisanja** (`createWalletClient`: forward, deploy Safea, setup execute) ostaju na
  `http(rpcUrl)`. Ako čvor zaostaje ili ima malo peerova, pisanje ne smije ovisiti o njemu
  dok to ne izmjerimo.
- `simulateForwardViaSafe` (`router/safe.ts`) nema `env` u potpisu i ostaje na javnom RPC-u.
- `setup/projects.ts` i `setup/execute.ts`: javni klijent ide u paru s pisanjem
  (`waitForTransactionReceipt` za tx poslan na javni RPC).
- **Popis uplata u `/api/activity`** i dalje čita Blockscout. Bez log indexa Nethermind
  dopušta najviše 10.000 blokova po `eth_getLogs`. Izmjereno 23. 10. 2026: 500.000 blokova u
  batchu od 50 upita traje 11,5 s, a godina (367 dana povijesti, ADR-010 čvora) oko 145 s. To
  je prespor za čitanje po zahtjevu. Sljedeći korak je `LogIndex.Enabled` na i9 (predaja u
  `domovina-gnosis-node`). Ako se backfill pokaže razumnim, popis ide na `eth_getLogs`, a
  Blockscout ostaje rezerva. Ako ne, indexer u Workeru sprema uplate u D1.

## Posljedice

- Javni RPC vidi samo promet koji čvor ne posluži. Pad čvora i tunela košta latenciju (do 4 s
  na prvom pozivu u izolatu), a ne neuspjelo čitanje.
- Token `eure-reader` ima rok trajanja. Kad istekne, Access vraća 403 i sve tiho ide na
  rezervu. Pazi na `acutis …; using fallback` u logovima Workera.
- Rotacija tokena: novi token u Access politici, pa
  `wrangler secret put CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`, pa brisanje starog.

## Odbačeno

- **`ACUTIS_RPC_URL` umjesto `GNOSIS_RPC_URL`:** vrijednost završi u CSP-u i pregledniku, a
  token nikad ne bi smio tamo.
- **viem `fallback([http(own), http(pub)])`:** ne zna da čvor koji se sinkronizira odgovara
  bez greške, ali sa starim stanjem, a i revert bi ponovio na rezervi.
