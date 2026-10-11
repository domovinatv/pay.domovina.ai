# Uplate po projektu: Safe + Monerium memo (sandbox stanje 11. 10. 2026.)

Cilj: svaki javni projekt s projekti.domovina.ai dobiva vlastiti Safe za donacije
(SEPA → EURe preko Monerium IBAN-a ITalka, ili izravno EURe), da se po saldu vidi
gdje se skuplja najviše novca. ITalk d.o.o. je vlasnik svih projekata, pa primanje
na ITalk profil nije „u ime trećeg" (Monerium ToS §16). Drugi ljudi isto rade kroz
vlastiti Monerium račun i vlastitog MPT tenanta.

Vezani dokumenti: [monerium-private.md](monerium-private.md) („Appovi, profili i MPT
tenanti", „Usmjeravanje po memu") · [ADR 0017](decisions/0017-multi-tenant-rail.md) ·
`energy.domovina.ai/docs/15` (ručni postupak za elektrane, ispravak 11. 10.)

## Odluka: opcija 2, izravni mint u Safe projekta

```mermaid
flowchart LR
  D[Darovatelj] -- "SEPA na ITalk IBAN<br/>opis: gnosis:0x&lt;Safe projekta&gt; sid:&lt;sid&gt;" --> M[Monerium]
  M -- "mint EURe ravno" --> P[Safe projekta]
  M -. "webhook order.*" .-> R[MPT rail]
  R -- "sid → zatvori intent<br/>(bez forwarda)" --> I[(intent)]
```

| | Opcija 1: forward kroz Roles | **Opcija 2: izravni mint** |
|---|---|---|
| Put novca | IBAN → glavni Safe → forward | IBAN → **Safe projekta** |
| Ručni korak po projektu | 2/3 tx: Safe na on-chain popis Roles | nema |
| Rail potpisuje | da (router EOA) | ne |
| Tko plaća prijenos | mi (plin) | Monerium |

Odbačena opcija 1 zbog ručnog 2/3 potpisa za svaki novi projekt (ADR 0017 drži
on-chain popis primatelja) i zato što rail tada drži ključ koji miče novac.

Dokaz da opcija 2 radi: produkcija, 1 € iz Revoluta, opis
`gnosis:0x4f7f…d0173 sid:test1` → 1 EURe na Lukavec Safe (15,34 → 16,34), rail
Safe 0. Pravilo i tablica oblika: monerium-private.md „Usmjeravanje po memu".

## Automatizacija: `tools/funding`

```bash
cd tools/funding && npm install
node funding-init.mjs --env sandbox --project <id> --title "<naziv>"
node check-balances.mjs --env sandbox --main <glavni Safe>
```

`funding-init` (idempotentan): Safe `project:<id>` → provjera vlasnika/praga/ERC-1271 →
Monerium `POST /addresses` → `projects.<env>.json` → ispiše dvije naredbe za konzolu
preglednika (ime adrese u Moneriumu, kampanja na MPT railu), jer oba API-ja traže
web sesiju.

Ključni trik: Safe se rodi s potpisanom Monerium porukom. `setup()` delegatecall na
SignMessageLib upiše `signedMessages[hash]`, pa `isValidSignature(hash, "0x")` vrati
`0x1626ba7e` i Monerium link prolazi s potpisom `"0x"` (201 linked) bez ijednog
potpisa vlasnika. Provjereno na sandboxu.

Zamke:
- **Chiado ima samo Safe 1.3.0** (1.4.1 i 1.5.0 nisu deployani). Gnosis prod: energy
  Safeovi su 1.5.0, rail Safe 1.4.1. Skripta bira verziju po okruženju.
- Adresa vlasnika `0xF3c4…6FB8` ima nestandardan checksum; viem je odbija, pa se
  vlasnici šalju malim slovima.
- Ime adrese u Moneriumu nije u javnom API-ju (v2 nema polje; `PATCH /api/addresses/:a/config`
  samo pod web sesijom, token appa dobiva 401).
- Sandbox „Simulate bank transfer" šalje nasumičan memo; vlastiti memo ide preko
  `POST /api/treasury/fund` iz konzole na sandbox.monerium.dev.
- Faucet za Chiado (gnosisfaucet.com) traži captchu, e-mail i potpis; klik na
  karticu CHIADO jednom je preusmjerio na lažnu captchu na `*.s3.filebase.io`.
  Otvarati izravno `https://faucet.gnosischain.com/?chain=chiado`.

## Stanje sandboxa (Monerium sandbox + Chiado)

| Što | Vrijednost |
|---|---|
| Monerium račun | sandbox, profil `22ac32be-3573-11f1-a66a-a6312d42aaad`, app `italk_domovina_projekti_sandbox` |
| Vjerodajnice + deployer ključ | `tools/funding/.env.sandbox` (gitignored, chmod 600) |
| Deployer EOA | `0x99150f78B30875323559B2C9aE232b5AB6464c65` (~0.04 xDAI) |
| MPT tenant | `italk-sandbox`, status **active**, `tenant_rail.mode = 'direct'` |
| Glavni Safe (IBAN `EE51 4996 0969 7740 7661`) | `0xe2e21755d3F576F090Ecda1D830F3fDA865f37fF` (`italk-sandbox:main:v2`) |
| Router EOA (nepotreban za opciju 2) | `0x2964eEb493a386eC9A249570da3a70527a74D26B` (0.06 xDAI) |
| Webhook | `/api/monerium/webhook/t/italk-sandbox`, pretplata `ce5223ef-…` |
| Projekt Karta Hrvatske | `0xb3438D62c7B968806a7E3D78fc4b31Ee8F738720`, kampanja `domovinatv-karta-hrvatske` |
| Projekt Stranke | `0x346230f2748745a1D19550969f0b239F3D2b5896`, kampanja `domovinatv-stranke-domovina-ai` (12. 10.) |
| Testni Safe | `0xfD07de234B8b1EE2a3Dca787Fc87232ce21471C2` (`project:test-link-1`) |
| Napušteni Safe | `0x93BFfFB0D6a255feC3256F7f4743fef4df344D6b` (bez potpisane poruke, prazan) |

`verify` za `italk-sandbox` u načinu direct prolazi (profil, IBAN → glavni Safe, Safe
deployan, webhook, 1 kampanja); Roles, role key, plin routera i kapica se ne provjeravaju.

Usput: prihvatni Safe tenanta `crosulja-staging` (`0xc857…`) na Chiadu **nema koda**.

## Način „direct" na railu (PR #85, deploy 11. 10. 2026.)

`tenant_rail.mode = 'direct'` (migracija 0026), postavlja se kroz `PUT /admin/api/tenants/:id/rail`
s poljem `mode` (ostala polja poslati kakva jesu, jer izostavljeno polje postaje NULL).

- `POST /api/intents`: cilj mora biti aktivna kampanja tenanta (inače `403 target_not_campaign`).
  `memo`, `epc_qr_data` i checkout nose `<chain>:0x<safe> sid:<sid>`, gdje je chain `chiado` na
  sandboxu i `gnosis` na produkciji. HUB3 ostaje bez sida.
- Webhook: order mintan na cilj intenta dobiva forward red `confirmed`, `error = direct_mint`,
  `amount_wei = 0`, a intent je `paid`. Inače park: `not_minted_to_target` (npr. Revolut
  izgubio referencu, novac na glavnom Safeu), `target_mismatch`, `missing_sid`, `unknown_sid`,
  `tenant_mismatch`.
- Rail u ovom načinu nikad ne potpisuje: router ključ se ne učitava.
- Checkout ima okvir s referencom, gumb „Kopiraj referencu" i uputu za Revolut.

Dokaz (sandbox, 11. 10. 2026.): intent `3qtbx28szhce` (7 €, Karta Hrvatske), uplata
`POST /api/treasury/fund` s referencom intenta → order `18a91cb6-…`, Karta 17,29 → 24,29 EURe,
glavni Safe ostao 15,15, intent `paid`/`settled` za ~20 s, forward #93 `direct_mint`, bez tx-a.
Javni ključ `pk_` za `italk-sandbox` izdan je u adminu (label „karta-hrvatske test direct"),
nije nigdje spremljen; za novi test izdati novi ili ga opozvati.

Drugi projekt (12. 10. 2026., `domovinatv-stranke-domovina-ai`): `funding-init` → kampanja →
ime u Moneriumu → intent `w526x3mrsqu7` (3,33 €) → mint ravno u Safe projekta, intent `settled`,
forward #94 `direct_mint`. Intent na adresu koja nije kampanja dobiva `403 target_not_campaign`.
Uplata bez reference (memo „Donacija", 2,27 €, intent `qygy3ghbbua3`) završila je na glavnom
Safeu (15,15 → 17,42). Intent je ostao neplaćen, a forward #95 je `blocked / not_minted_to_target`
s alarmom. Takvu uplatu operater ručno prebacuje u Safe projekta.

## Otvorene stavke

1. ~~Rail u načinu „direct"~~ i ~~gumb „kopiraj referencu"~~: gotovo, PR #85 (vidi niže).
2. PBZ je instant uplatu na EE IBAN odbio (ref. `20261011001286300522`, opis netaknut,
   razlog nepoznat). Svih 78 dosadašnjih dolaznih uplata je iz Revoluta (LT). Ponoviti
   kao običnu SEPA s adresom primatelja ili pitati PBZ.
3. Prod: `funding-init --env prod` za projekte (Safe 1.5.0, SignMessageLib adresa za
   1.5.0 još nije upisana u `lib.mjs`), deployer s xDAI na Gnosisu.
4. Katalog: polje `funding` na kartici (`realtime-presentation`), gumb „Podrži".
5. Admin: opoziv API ključa nije moguć kroz API, jer `GET …/keys` vraća samo `key_hash_short`, a
   `DELETE …/keys/:keyHash` traži puni hash. Testni `pk_` ključ „karta-hrvatske test direct" za
   `italk-sandbox` zato je još aktivan.
6. `funding-init` korak 5b u nazivu spominje „kampanja + whitelista", ali upisuje samo kampanju
   (za način direct je to dovoljno).
