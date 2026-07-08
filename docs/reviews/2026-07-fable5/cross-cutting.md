# Cross-cutting — nalazi (XD-*)

Presjek podsustava: duplikacija, RPC SPOF, CREATE2 parity, mrtvi kod.
Napomena: finderi `cross-money-flow`, `cross-duplication`, `cross-test-gap`
NISU dovršeni pod Fable 5 (krediti). Ovi nalazi su Opusova ručna sinteza iz
per-podsustav findera + direktnog čitanja koda.

---

## XD-01 [RISK / TEST-GAP] Dvije nezavisne CREATE2 implementacije bez parity testa

**file:** `wallet/src/lib/safe.ts:74` (`predictSafeAddressForOwners`, koristi Safe
**protocol-kit** SDK) vs `wallet/functions/_lib/safe.ts:220`
(`predictSafeProxyAddress`, hardkodirani `SAFE_PROXY_INIT_CODE_HASH` +
ručni `getCreate2Address`)

**Failure scenarij (verificiran):** Klijent predviđa Safe adresu preko
protocol-kita (`safeAccountConfig: {owners, threshold}, saltNonce`); relayer
predviđa ISTU adresu preko hardkodiranog init-code-hasha i ručnog
`buildSafeInitializer`. Obje MORAJU dati bajt-identičnu adresu — klijent funda
adresu X, relayer deploya na adresu Y. Ako protocol-kit verzija promijeni default
(fallback handler, singleton) ili klijent proslijedi drugačiji fallbackHandler od
relayerovog hardkodiranog `COMPATIBILITY_FALLBACK_HANDLER`, adrese diverge.

**Zaštitna mreža (postoji):** relayer primarni cold-path guard
(`relay.ts:291`, `predictedSafe !== safeAddress → 400`) SPRJEČAVA stranding —
relayer odbije deploy na mismatch. Dakle divergencija se manifestira kao
**liveness bug** (korisnik ne može poslati, relay vraća 400), NE kao gubitak
novca — OSIM na WR-02 fallback grani koja guard preskače.

**Fix:** CI parity test koji tvrdi
`clientPredict(owners, threshold, salt) === relayerPredict(owners, salt)` za
matricu (1-owner salt 0, 2-owner ADR-0013, pinka campaign salt). Uhvati
divergenciju na buildu, ne na korisnikovom Send-u.

**Acceptance:** Test file koji importa obje funkcije i tvrdi jednakost adresa za
≥3 slučaja; pada ako se init-code-hash ili initializer razlikuju.

---

## XD-02 [RISK] Jedan hardkodirani `rpc.gnosischain.com` bez fallbacka na CIJELOM on-chain putu

**file:** `backend/src/router/safe.ts:142,221`, `backend/src/intents/onchainIndexer.ts:63`,
`backend/wrangler.toml:79`, `wallet/src/lib/constants.ts:17`,
`wallet/functions/_lib/relayer.ts:45`

**Failure scenarij (verificiran):** Svaki on-chain put — Monerium forward
broadcast, receipt poll, cron reconcile, onchain donation indexer, wallet balance
read, wallet relayer `getCode` pre-flight + broadcast — koristi
`env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com'` bez ijednog fallbacka. Kad
taj besplatni endpoint ima outage ili rate-limit, cijeli settlement/relay stane;
`getCode` (kritičan za stranding zaštitu) i receipt poll (kritičan za paid flip)
tiho vraćaju `unknown`/greške. SPOF na cijeli novčani put.

**Fix:** Lista RPC endpointa s failoverom (viem `fallback([http(a), http(b), …])`).
Uključiti barem jedan plaćeni/pouzdani (npr. vlastiti node / Ankr / Gateway) uz
javni. Isti wrapper dijeliti backend + wallet.

**Acceptance:** Ubij primarni RPC → forward/relay/balance i dalje rade preko
fallbacka; log pokaže failover.

---

## XD-03 [BUG] MPT_IBAN konstanta sadrži zalutali razmak

**file:** `backend/src/intents/api.ts:34` *(finder; Opus re-verify TODO)*

**Failure scenarij:** `MPT_IBAN` navodno sadrži razmak (`'EE7077770001629211 28'`)
i vraća se sirov u API JSON-u. Ako se taj IBAN koristi u EPC/HUB3 generiranju ili
ga korisnik kopira, razmak može uzrokovati odbijanje SEPA naloga ili krivi
IBAN match. **Confidence: medium** — treba potvrditi čitanjem `api.ts` i svih
consumera IBAN-a (potencijalno MONEY-BUG ako uđe u payment string).

**Fix:** Ukloniti razmak; validirati IBAN (bez razmaka, ispravan mod-97 checksum)
na jednom mjestu.

**Acceptance:** `MPT_IBAN` prolazi IBAN validaciju; grep nema razmaka u IBAN
konstantama.

---

## XD-04 [REFACTOR] Duplikacije i mrtvi kod

- **hmac / decodeSecret helperi** duplicirani u ≥2 filea (backend). Konsolidirati
  u jedan `crypto` util. *(finder)*
- **Enable Banking `session_id` KV zapisi** su write-only mrtvi kod; token-cache
  + `call<T>` wrapper tripliciran u 3 provider klijenta
  (`enable_banking.ts:172`, `gocardless.ts`, `index.ts`). Izvući zajednički
  `BankingClient` base. *(finder)*
- **`balance.ts` vs `balances.ts`** (wallet) dupliciraju isti fetch (vidi WP-12).
- **Block explorer inkonzistencija** (Flutter): gnosisscan vs blockscout mix
  (FL-REFACTOR).

Nijedan nije MONEY/SEC; svi su altitude/održavanje. Grupirati u F3.
