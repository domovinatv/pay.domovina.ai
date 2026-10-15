# ADR 0025 — MPT router umirovljen: svi tenanti u izravnom načinu, MPT ne drži ključ koji pomiče novac

- **Status:** Accepted (2026-10-15)
- **Kontekst:** MPT rail (`backend/`), MPT Safe `0x449a…af2e`, Roles modifier `0x3303…762c`
- **Gradi na:** [0017](0017-multi-tenant-rail.md) (rail po tenantu, način `direct` iz migracije 0026) ·
  [0016](0016-tenant-payout-whitelist.md) (whitelist) ·
  [postmortem 0002](../postmortems/0002-admin-auth-bypass-percent-encoded-path.md)
- **Zamjenjuje:** [0019](0019-off-cloud-forward-signer.md). Ako se forward više ne radi, ne treba ga
  ni potpisivati kvorum Android uređaja.

## Problem

Do danas je zadani tenant (`italk`) radio u načinu `forward`. Monerium minta EURe u MPT Safe,
a Worker s `ROUTER_PRIVATE_KEY` (Workers secret) preko Zodiac Roles role `EUReForwarder`
prosljeđuje ga dalje. Rola dopušta `EURe.transfer` **bez uvjeta na primatelja i iznos**
(ADR 0019, §Problem). Tko ima taj ključ, prazni Safe bez 2/3 vlasnika.

Postmortem 0002 (14.10.) pokazao je koliko je to blizu. Napadač s admin pristupom nije
mogao pročitati ključ (rail je redigiran), ali je dodao svoju adresu na whitelist i izdao
si tajni API ključ. Jedan intent s njegovom adresom bio bi dovoljan da sljedeća uplata ode
njemu: whitelist i resolver odlučuju u Workeru, a Worker je tada bio njegov.

U međuvremenu se model promijenio. Svaki vlasnik u **svom** Monerium računu poveže N
namjenskih Safe-ova (po projektu), a referenca `gnosis:<Safe> sid:<sid>` natjera Monerium
da minta ravno tamo. Način `direct` (migracija 0026, PR #85) to već radi za tenante s
redom u `tenant_rail`. Samo je legacy rail (`italk` iz env-a) ostao na routeru:
15.10. još je bilo tri potvrđena forwarda na Safe kampanje Lukavec.

## Odluka

**Nijedan tenant ne radi forward. MPT je orkestrator i notifier: uparuje uplatu s
intentom, javlja webhook i SSE, i plaća gas za transakcije koje su korisnici već
potpisali. Ključ koji može pomaknuti EURe ne postoji ni u Workeru ni na Safe-u.**

| Uloga | Tko | Ovlast nad novcem |
|---|---|---|
| Mint na pravu adresu | Monerium, po referenci `gnosis:<Safe> sid:` | — |
| Uparivanje i obavijest | Cloudflare Worker | nema |
| Sponzor gasa | relayer EOA (`wallet/functions/_lib/relayer.ts`) | samo vlastiti xDAI |
| Odljev iz Safe-a | vlasnici Safe-a (MPT Safe: 2/3) | da |

### Koraci

1. **`italk` na direct** (`LEGACY_RAIL_MODE = "direct"` u `wrangler.toml`). Legacy rail i
   dalje čita Monerium vjerodajnice iz env-a, ali je `mode: 'direct'`. `ROUTER_PRIVATE_KEY`,
   PaymentRegistry i MultiSend se ne učitavaju, a referenca postaje `gnosis:<Safe> sid:<sid>`.
   Nepoznata vrijednost zastavice znači `direct`, način koji ne može potpisati (fail-closed).
   Ostavljanje varijable praznom vraća stari router (rollback, dok koraci 3–4 nisu izvršeni).
2. **Stare `mpt:` reference.** QR kodovi i intenti koji su već vani i dalje mintaju u MPT
   Safe. Direct gate ih vodi kao D4 `direct_owed`: intent se veže uz uplatu, a Telegram
   javi točan iznos i adresu. EURe ostaje u MPT Safe-u dok ga 2/3 vlasnika ne prebace.
   Detektor odljeva prepozna taj prijenos i tek tada označi intent plaćenim
   (`settleOwedOutflow`). Ista sudbina čeka uplatu na Safe koji **nije povezan** s
   Monerium profilom (`monerium-private.md`, „Usmjeravanje po memu").
3. **On-chain, 2/3 potpis:** `safe-tx/008-retire-router.mjs` →
   `Roles.assignRoles(router 0xd612…54CB, [EUReForwarder], [false])` +
   `Safe.disableModule(SENTINEL, Roles)`. Nakon toga Safe nema modul, pa svaki odljev traži
   2/3 vlasnika.
4. **Brisanje ključeva:** `wrangler secret delete ROUTER_PRIVATE_KEY` te router ključevi
   (`router_key_enc`) na `crosulja-staging` i `italk-sandbox`. Prvi je jedini tenant koji je
   ostao na `forward` pa ide na `direct`, a drugi je na `direct` s ostatkom ključa.
5. **Dokumentacija:** ADR 0019 je *Superseded*, a `safe-tx/006` (scoping role) više nije
   potreban.

### Što namjerno prestaje raditi

- **Intent za `italk` na adresu koja nije Safe kampanje** (npr. punjenje walleta):
  direct način traži `findCampaignBySafe`, pa vraća grešku. Wallet nadoplata ide
  preko vlastitog Monerium računa korisnika ili kampanje.
- **Flutter generator** (`lib/`, pay.domovina.ai) lokalno slaže `mpt:` referencu. Njegove
  uplate postaju D4 `direct_owed` (korak 2) dok se ne prebaci na `gnosis:`.
- **PaymentRegistry MultiSend put** (samo legacy forward) se više ne koristi.

## Provjera nakon deploya

- `/api/intents/<sid>` za novi `italk` intent vraća referencu `gnosis:0x… sid:…`.
- Jedna uplata od 1 € na Safe kampanje: mint mora sletjeti **u Safe kampanje**
  (`direct_settle`), ne u MPT Safe. Ako sleti u MPT Safe, Safe kampanje nije povezan s
  ITalk Monerium profilom: povezati ga (`tools/funding`) i ponoviti.
- `monerium_forwards` nakon deploya nema novih redaka sa `status='submitted'` i `tx_hash`
  za `italk`.

## Posljedice

- Krađa ključeva iz Cloudflarea (deploy, secret, admin) više ne znači krađu novca.
  Napadač može lagati u obavijestima (lažni `paid` webhook) i vidjeti podatke o uplatama,
  ali ne može pomaknuti EURe. To je i dalje ozbiljno, ali je druga klasa štete.
- Whitelist (ADR 0016) i kapica gube ulogu zaštite odljeva. Ostaju samo kao provjera
  namjere kod kreiranja intenta.
- ADR 0019 (Android kvorum za forward) otpada. Kvorum iz ADR 0004 ostaje za atestaciju.

## Implementacija

| Korak | Stanje |
|---|---|
| 1. `LEGACY_RAIL_MODE`, testovi `test/legacyDirectMode.test.ts` | ✅ ovaj PR |
| 2. Stare `mpt:` reference kao D4 | ✅ postojeći direct gate, bez promjene |
| 3. `safe-tx/008-retire-router` batch | 🟡 generiran, čeka 2/3 potpis |
| 4. Brisanje `ROUTER_PRIVATE_KEY` i router ključeva tenanata | ⏳ nakon koraka 3 |
| 5. ADR 0019 *Superseded*, INDEX | ✅ ovaj PR |
