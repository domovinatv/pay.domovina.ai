# ADR 0026 — ProjectRouter: rola na MPT Safe-u ograničena on-chain na projektne Safe-ove

- **Status:** Proposed (2026-10-16)
- **Kontekst:** MPT rail (`backend/`), MPT Safe `0x449a…af2e` (2/3), Roles modifier `0x3303…762c`
  (Zodiac Roles v2, mastercopy `0x9646…D337`)
- **Gradi na:** [0025](0025-mpt-router-umirovljen-svi-tenanti-direct.md) (§Revolut bez reference) ·
  [0018](0018-stray-payment-resolver.md) (stray resolver) ·
  [0017](0017-multi-tenant-rail.md) (rail po tenantu) ·
  [postmortem 0002](../postmortems/0002-admin-auth-bypass-percent-encoded-path.md)
- **Izvor:** [dogovoreni smjer, 16. 10. 2026.](../2026-10-16-router-ogranicen-na-projekte.md)

## Problem

ADR 0025 je skinuo router: MPT Safe nema modul, a `ROUTER_PRIVATE_KEY` je obrisan. Revolut
nakon skeniranja QR-a briše opis plaćanja, pa Monerium minta na MPT Safe. Stray resolver
uplatu ispravno veže uz intent, ali ona ostaje D4 `direct_owed` dok 2/3 vlasnika ručno ne
prebace novac. Uplata bez reference je normalan slučaj, ne iznimka (svih pet uplata 15. 10.),
a ručni prijenos kao trajno stanje i „Move IBAN" na Safe projekta su odbijeni (ADR 0025,
§Odbijeno).

Router koji smije `EURe.transfer` bilo kome (stara rola `EUReForwarder`) ne dolazi u obzir:
tko ima ključ, prazni Safe. Postmortem 0002 pokazao je koliko je to blizu.

## Odluka

**Rola `ProjectRouter` na MPT Safe-u smije samo `EURe.transfer(to, amount)`, gdje je `to`
jedan od projektnih Safe-ova koje su 2/3 vlasnika unaprijed odobrili. Ograničenje provodi
Roles modifier na lancu, ne Worker.** Rail tom rolom automatski prosljeđuje D4 uplate s
jednoznačnim intentom.

Sigurnost je u ograničenju na lancu, ne u mjestu ključa. Ključ routera živi kao Workers
secret, kao i prije ADR-a 0025. Razlika je u tome što s njim više nema puta do adrese izvan
skupa.

| Tko ima ključ / kontrolu | Što može |
|---|---|
| Router EOA (Workers secret) | `EURe.transfer` s MPT Safe-a **samo** na projektni Safe iz skupa |
| Kompromitirani Worker / Cloudflare račun | isto: novac ode u *krivi od vlastitih* projekata. Detektor odljeva to vidi, 2/3 vlasnika ispravljaju |
| Delegate MPT Safe-a (`funding-init`) | predložiti transakciju u red Safe-a; ne može je potpisati ni izvršiti |
| 2/3 vlasnika | mijenjaju skup, opozivaju rolu, gase modul |

Invarijanta iz INDEX-a („no cloud-held signing keys") ovdje je svjesno oslabljena: ključ u
oblaku postoji, ali ne može pomaknuti novac izvan skupa koji su potpisali vlasnici. To je ista
klasa štete kao lažna obavijest (ADR 0025, §Posljedice), ne krađa.

### Dozvola na lancu (`safe-tx/009`)

Jedan Safe batch, 2/3 potpis:

1. `Safe.enableModule(Roles 0x3303…)`: modul je ponovno uključen.
2. `Roles.revokeTarget(EUReForwarder, EURe | PaymentRegistry | MultiSendCallOnly)`: stara
   rola nema članova (`008`), ali su joj dozvole ostale zapisane, a modul se vraća. Brišu se
   da greška u budućem `assignRoles` ne bi vratila neograničeni `transfer` ni MultiSend.
3. `Roles.scopeTarget(ProjectRouter, EURe)`.
4. `Roles.scopeFunction(ProjectRouter, EURe, transfer(address,uint256), uvjeti, None)`:

   ```
   [0] Calldata  Matches                (root)
   [1] None      Or                      ← parametar `to`
   [2] Static    Pass                    ← parametar `amount` (bez kapice)
   [3…] Static   EqualTo projektᵢ       (djeca čvora [1])
   ```

   Za jedan projekt `[1]` je izravno `Static EqualTo`. `ExecutionOptions.None`: bez xDAI
   vrijednosti i bez DelegateCalla, pa ni MultiSend ni PaymentRegistry (`006` §1).
5. `Roles.assignRoles(novi router EOA, [ProjectRouter], [true])`.

Enumi i pravila stabla provjereni su na verificiranom izvornom kodu mastercopyja
(`Types.sol`, `Integrity.sol`, solc 0.8.21): logički čvor (`Or`) mora imati
`paramType = None`. `006` i `007` su ga slagali kao `Static`, što bi `scopeFunction` odbio s
`UnsuitableParameterType(1)`. Zajednički builder je ispravljen. Dokaz prije potpisa je
simulacija na forku (dopušteni primatelj prolazi, ostali revert), opisana u `009`.

**Bez kapice na iznos** (Matija, ADR 0019 §Odbijeno): ograničenje primatelja je dovoljno
jer je najgori ishod premještaj među vlastitim projektima.

### Novi projekt: prijedlog u redu Safe-a

`scopeFunction` **prepisuje** cijelo stablo, pa novi projekt znači novi `scopeFunction` s
punim popisom. Izvor popisa je lanac: zadnji događaj `ScopeFunction(ProjectRouter, EURe,
transfer)` na Roles modifieru, ne repo ni D1.

`tools/funding/funding-init.mjs` (nakon Safe-a projekta i Monerium linka):

1. pročita trenutni skup s lanca i doda novi Safe,
2. složi `scopeFunction` s punim popisom,
3. predloži transakciju u red MPT Safe-a preko Safe Transaction Servicea, potpisano ključem
   **delegatea**,
4. vlasnici potvrde u app.safe.global ili Safe mobilnoj aplikaciji („Needs confirmation").
   U dekodiranom prikazu provjeravaju da su stari projekti još na popisu.

Delegate jednokratno registrira jedan vlasnik. Njegov ključ živi lokalno kod Matije uz
`funding-init` (`.env.<env>`, gitignored). Admin gumb „Novi projekt" u Workeru je kasnija
odluka.

### Rail

```mermaid
flowchart LR
    O[D4 direct_owed<br/>jednoznačan intent] --> C{rail ima<br/>ProjectRouter?}
    C -->|ne| T[🧾 alarm: ručni 2/3 prijenos<br/>današnje ponašanje]
    C -->|da| S{eth_call simulacija<br/>execTransactionWithRole}
    S -->|revert| W[ostaje owed<br/>cron pokuša ponovno]
    S -->|ok| L[latch: owed → broadcasting<br/>atomski UPDATE]
    L --> B[broadcast]
    B -->|ok| SUB[submitted → confirmed<br/>postojeći put, paid + webhook]
    B -->|greška| F[failed + alarm]
```

- Novo stanje nije potrebno. Novi prijelaz `owed —router_claim→ broadcasting` zauzme red
  **prije** broadcasta. Tako webhook i cron ne mogu isti dug platiti dvaput. Dalje vrijede
  postojeći `broadcast_ok` / `broadcast_failed` i `receipt_*`.
- Simulacija ide **prije** latcha. Revert (projekt još nije u roli, prijedlog čeka 2/3,
  nedovoljan saldo) ostavlja red `owed`, a cron ga pokušava svaka 2 minute. Nakon potvrde
  prijedloga uplata se proslijedi sama.
- Greška nakon latcha je `failed` s alarmom, kao kod starog forwarda. Ne vraća se u `owed`,
  jer nejasna greška RPC-a može značiti da je tx ipak poslan, pa bi ponovni pokušaj platio
  dvaput.
- Rail bez role (nema `PROJECT_ROUTER_*` ili retka s ključem) ponaša se točno kao danas: D4 i
  Telegram. Kad rola postoji, alarm 🧾 kaže da vlasnici **ne** prenose ručno, jer bi
  prijenos koji detektor još nije vidio i router platili isti dug dvaput.
- Detektor odljeva: tx routera ima `tx_hash` u `monerium_forwards`, pa je `known`. Ako Worker
  padne između broadcasta i zapisa, red je `broadcasting` bez hasha, a detektor javlja ⚠️
  `role_unhashed`, ne 🚨.
- Postojeći `direct_owed` redovi plaćaju se automatski čim rola proradi (produkcija: #187,
  1 € Lukavec). Tko ih ne želi tako zatvoriti, mora ih zatvoriti prije deploya.

Konfiguracija:

| Rail | Ključ | Roles / role key |
|---|---|---|
| `italk` (legacy) | Workers secret `PROJECT_ROUTER_PRIVATE_KEY` | `ROLES_MODIFIER_ADDRESS`, `PROJECT_ROUTER_ROLE_KEY` (`wrangler.toml`) |
| tenant u `tenant_rail` (`mode = 'direct'`) | `router_key_enc` | `roles_modifier`, `role_key` |

Stari `ROUTER_PRIVATE_KEY` / `ROLE_KEY` (`EUReForwarder`) se ne vraćaju. Ključ je nov
(`safe-tx/000`, generira Matija offline), a stari EOA `0xd612…54CB` ostaje bez role.

## Odbijeno

- **Android telefon kao router bez ograničenja na lancu.** Ukraden ili rootan telefon prazni
  Safe jednako kao ukraden secret. Telefon mora pitati Worker kamo slati, a kompromitirani
  Worker ga navodi. Dok je telefon ugašen, uplate čekaju. Može doći **kasnije** kao zaštita
  od krivog rutiranja među vlastitim projektima.
- **Kapica na iznos ili allowance** (ADR 0019, §Odbijeno): fragmentira legitimne uplate.
- **Popis primatelja u D1 ili repou kao izvor istine:** popis koji rail misli da vrijedi i
  popis koji Roles provodi bi se razišli. Lanac je jedini izvor.

## Otvoreno

- **Per-tenant:** svaki tenant s vlastitim glavnim Safe-om treba svoju rolu i svoj Roles
  modifier (uzor `007`, bez kapice). Za sada `italk` i `italk-sandbox`.
- **Veličina `Or` stabla:** `parent` je `uint8` (najviše 256 čvorova), a stablo se sprema kao
  SSTORE2 blob, pa plin raste linearno s brojem projekata. Do ~50 projekata to nije
  problem. Za više: custom condition s registry ugovorom kojim upravlja 2/3.
- **Delegate ključ u Workeru** za admin gumb „Novi projekt".

## Redoslijed

1. Ovaj ADR (Proposed → Accepted nakon Chiada).
2. `safe-tx/009` generator, enumi provjereni, simulacija na forku.
3. `tools/funding`: korak s delegateom.
4. Rail: latch, simulacija, cron, testovi.
5. Chiado (`italk-sandbox`, Safe 1.3.0): Roles proxy, batch 009, prijedlog delegatea, D4
   uplata → automatski forward. Redovi #96 i #97 su prirodni test.
6. Produkcija: novi router ključ kao Workers secret, batch 009 (2/3), deploy.

## Implementacija

| Korak | Stanje |
|---|---|
| 1. ADR | 📝 ovaj PR |
| 2. `safe-tx/009` | ⏳ |
| 3. `funding-init` + delegate | ⏳ |
| 4. Rail | ⏳ |
| 5. Chiado E2E | ⏳ |
| 6. Produkcija | ⏳ |
