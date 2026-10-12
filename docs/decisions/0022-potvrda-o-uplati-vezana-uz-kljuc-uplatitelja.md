# ADR 0022 — Potvrda o uplati vezana uz ključ uplatitelja: `sid` = otisak ključa, offline PDF, sidrenje na Gnosisu i OpenTimestamps

- **Status:** Proposed (2026-10-12). Ništa još nije implementirano.
- **Kontekst:** MPT rail (`backend/`), intent API (`backend/src/intents/api.ts`), generator `sid`-a
  (`backend/src/intents/sid.ts`), `PaymentRegistry` (`backend/contracts/PaymentRegistry.sol`),
  forward s `registry.record(...)` (`backend/src/router/safe.ts`), checkout stranica i Flutter
  `pay.domovina.ai`, wallet.domovina.ai
- **Gradi na:** [0001](0001-no-server-side-recovery.md) (self-custody: dokaz ne smije ovisiti o
  našoj bazi) · [0012](0012-recovery-seed-second-owner-interop.md) (oporavak Safe-a) ·
  [0016](0016-tenant-payout-whitelist.md) (`memo_prefix`) · [0018](0018-stray-payment-resolver.md)
  (uplate bez reference) · [0020](0020-hr-iban-listener-bez-minta.md) (HUB3, bez `sid`-a u opisu)
- **Regresijski ugovor:** samo dodaje ponašanje. Postojeći `sid`-ovi i njihov format ostaju
  nepromijenjeni, a stari testovi prolaze bez izmjena (`scripts/compat-check.sh`).

## Problem

Želimo da uplatitelj, kad je uplata vidljiva, može spremiti **potvrdu o uplati**. Potvrda mora
imati ova svojstva:

1. Može se provjeriti i za deset godina, bez MPT servera i baze.
2. Na temelju nje se u budućnosti mogu preuzeti prava, npr. claim tokena ili glas.
3. **Nitko drugi je ne može preuzeti**: ni onaj tko vidi lanac ili izvod, ni trgovac, ni MPT.
4. Radi i za anonimnog uplatitelja, bez računa na domovina-api.

### Zašto današnji `sid` ne zadovoljava (3)

`sid` je javan po konstrukciji:

| Gdje je vidljiv | Tko ga vidi |
|---|---|
| opis SEPA naloga (`mpt:0x…?sid=…`) | uplatiteljeva banka, Monerium, MPT |
| `Payment(bytes32 indexed sessionId, …)` na Gnosisu | svi |
| `GET /api/intents/:sid` | svi koji znaju `sid` |
| QR na checkout stranici ili posteru | svi koji ga vide |

Potvrda „platio sam `sid` X" zato dokazuje **da je** uplata postojala, a ne **tko** ju je
napravio. Ako bi `sid` bio uvjet za claim, svatko tko čita lanac mogao bi preuzeti tuđe pravo.

### Zašto ne rješenje preko prijave (domovina-api)

Prijavljeni korisnik bi dobio potvrdu jer backend kaže „intent je stvorio korisnik 123". To je
tvrdnja naše baze. Ona ne preživljava gašenje servisa, MPT je može krivotvoriti, a ne radi za
anonimne uplatitelje. Kršila bi duh ADR 0001: dokaz o vlasništvu ne smije ovisiti o nama.

## Odluka

### 1. `sid` je kriptografska obveza na ključ uplatitelja

Uplatiteljev uređaj **prije plaćanja** odredi vlasnika potvrde i iz njega izvede `sid`:

```
owner   = adresa (EOA iz ephemeral ključa ILI adresa Safe-a)
salt    = 16 nasumičnih bajtova
digest  = keccak256( "MPT-RECEIPT-v1" ‖ owner ‖ salt )
sid     = "r1" ‖ base32(digest)[0:24]        // 26 znakova, 120 bitova
```

- Abeceda je ista kao u `generateSid()` (32 znaka, bez 0/O/1/l/I), pa je to 5 bitova po znaku.
- 26 znakova stane u `SID_RE` (`^[A-Za-z0-9_-]{6,32}$`) i u `bytes32` (`asciiToBytes32`).
  **Backend validacija se ne mijenja.**
- Prefiks `r1` razlikuje `sid` vezan uz potvrdu od starih, nasumičnih. Stari `sid` od 12 znakova
  nikad ne počinje s `r1` i ima 26 znakova, pa sudara nema.
- `salt` služi privatnosti. Bez njega bi svatko tko zna nečiju Safe adresu mogao provjeriti je li
  ta adresa platila određeni `sid`.
- 120 bitova znači da napadač za tuđi `sid` mora naći drugu predsliku (second preimage) od 2^120
  pokušaja. To je izvan dosega i državnih aktera.

Uplatitelj **sam** upisuje `sid` u svoj bankovni nalog (EPC QR ga prenosi). Zato ni MPT ni
trgovac ne mogu naknadno podmetnuti drugog vlasnika: `sid` u nalogu već drži obvezu na ključ.
Monerium je neovisan svjedok, jer njegov order bilježi opis naloga onako kako ga je banka poslala.

`POST /api/intents` već prima `sid` koji je generirao klijent (`body.sid`, `intents/api.ts:42`),
pa za stvaranje intenta ne treba novi endpoint.

### 2. Tri razine vlasnika

| Razina | `owner` | Kako se dokazuje vlasništvo | Napomena |
|---|---|---|---|
| **Wallet (preporučeno)** | adresa Safe-a s wallet.domovina.ai | ERC-1271 potpis (passkey ili seed) | Nema tajne u PDF-u. Gubitak passkeyja pokriva oporavak Safe-a (ADR 0012). Safe smije biti counterfactual, a deploy ide pri prvom claimu. |
| **Anonimno** | adresa ephemeral secp256k1 ključa generiranog u pregledniku | ECDSA potpis tim ključem | PDF nosi ključ, pa je **bearer instrument**: tko ima ključ, ima pravo. Ključ je zato u zasebnom dijelu PDF-a i po želji enkriptiran (§4). |
| **Bez potvrde** | — | — | Današnji nasumični `sid`. Ponašanje je nepromijenjeno. |

Prijava na domovina-api **nije** razina vlasnika. Može postojati kao pogodnost (pohrana
enkriptiranog ključa), ali izvor istine je uvijek potpis vlasnika.

### 3. Samo uplata s referencom daje potvrdu s pravom na claim

Stray resolver (ADR 0018) pridružuje uplatu bez reference intentu po tenantu, iznosu i vremenu.
To je dovoljno dobro za isplatu trgovcu, ali **ne dokazuje tko je platio**. Dva uplatitelja s
istim iznosom u istom prozoru nerazlučivi su, pa bi resolver mogao tuđu uplatu „upisati" na
nečiji `r1` intent.

Pravilo se uvodi u forward:

| `memo_prefix` forwarda | `kind` u `Payment` eventu | Pravo na claim |
|---|---|---|
| `mpt`, `cmp` (`sid` stigao u opisu naloga) i `sid` počinje s `r1` | `rcpt1` | da |
| `auto`, `manual` (ADR 0018) i `sid` počinje s `r1` | `rcpt1-unbound` | ne |
| bilo koji, `sid` bez `r1` | kao danas (`payment`, …) | ne |

Oznaka je **na lancu**, u istoj transakciji kao prijenos EURe. Verifikator i claim ugovor ne
moraju pitati MPT kakvo je bilo uparivanje.

Iz toga slijedi da **HUB3** (ADR 0020) ne daje potvrdu s pravom na claim. Opis HUB3 naloga ne
nosi `sid`, pa je svaka HUB3 uplata stray. Poziv na broj (model HR00, do 22 znamenke, oko 73 bita)
mogao bi nositi skraćeni digest, ali 73 bita nije dovoljno protiv napada drugom predslikom.
Zato je HUB3 izvan opsega ove odluke.

### 4. Offline PDF

Kad intent prijeđe u `confirmed`, uplatiteljev preglednik dohvati javne podatke i **lokalno**
složi PDF. Ključ i `salt` nikad ne napuštaju uređaj.

PDF ima dva dijela:

**A. Potvrda (smije se dijeliti)**

- `sid`, iznos, valuta, tenant (ime i Gnosis adresa primatelja), datum i vrijeme
- Gnosis: `chainId 100`, hash forward transakcije, `logIndex` `Payment` eventa, broj bloka
- `owner` i `salt` (otkrivaju samo vezu `sid` ↔ vlasnik, ne daju pravo na claim)
- kanonski JSON potvrde (RFC 8785 JCS) kao PDF prilog i u QR kodu
- OpenTimestamps dokaz (`.ots`) kao PDF prilog (§5)
- upute za provjeru bez MPT-a: „u bloku N postoji `Payment(sessionId=sid, kind=rcpt1, …)`, a
  `keccak256("MPT-RECEIPT-v1" ‖ owner ‖ salt)` daje taj `sid`"

**B. Ključ za preuzimanje (samo anonimna razina, ne dijeliti)**

- privatni ključ ephemeral vlasnika, kao QR i tekst
- po izboru enkriptiran lozinkom (scrypt, AES-GCM), a podrazumijevano je enkriptiran ako je
  korisnik upisao lozinku
- UI jasno kaže: „Tko ima ovu stranicu, može preuzeti vaše pravo. Ne šaljite je nikome."
- ista tajna ostaje i u `localStorage` preglednika, pa gubitak PDF-a nije nužno i gubitak prava

Za razinu wallet dio B ne postoji.

Dokaz „ja sam taj uplatitelj" pred trećom stranom (npr. organizatorom glasanja) ide izazovom:
verifikator pošalje nasumičnu poruku, a vlasnik je potpiše ključem ili Safe-om. Sama potvrda (A)
dokazuje da uplata postoji, a potpis dokazuje da je pokazivač vlasnik.

### 5. Sidrenje

1. **Primarno: `Payment` event na Gnosis mainnetu.** Već postoji u forward transakciji
   (`registry.record` + `EURe.transfer` u jednom MultiSendu). Dovoljan je za provjeru i claim.
2. **Neovisno: OpenTimestamps na Bitcoinu.** Jednom dnevno backend složi Merkle stablo
   kanonskih JSON-a svih `rcpt1` potvrda tog dana. Korijen ide:
   - u `PaymentRegistry.record(sessionId=root, kind="rcpt1-root", recipient=0, token=0, amount=0, metadataURI="")`
     (postojeći ugovor, bez novog deploya)
   - i na OpenTimestamps kalendare.

   PDF generiran odmah nosi „pending" OTS dokaz. Potpun dokaz (nakon Bitcoin potvrde, nekoliko
   sati) uplatitelj preuzme kasnije s `GET /api/intents/:sid/receipt`, a stranica ponudi
   ponovno generiranje PDF-a. Bez potpunog OTS-a potvrda i dalje vrijedi, samo bez drugog sidra.
3. **Chiado se ne koristi za potvrde.** Testnet se može resetirati, pa ne vrijedi kao trajni
   dokaz. Koristi se samo za razvoj i testove claim ugovora.
4. **Potpis MPT-a nije izvor istine.** EIP-712 potpis MPT-ovog „receipt" ključa smije biti
   pogodnost za brzu provjeru, ali rotacija ključa i gašenje servisa ga oslabe. Lanac je dokaz.

### 6. Claim (smjer, ne implementacija)

Budući claim ugovor provjerava:

```
claim(sid, owner, salt, recipient, deadline, signature, paymentProof)
  1. sid == "r1" ‖ base32(keccak256("MPT-RECEIPT-v1" ‖ owner ‖ salt))[0:24]
  2. signature je potpis vlasnika nad EIP-712 Claim{sid, recipient, deadline, chainId, verifyingContract}
     → ecrecover == owner, ili ERC-1271 isValidSignature na owner (Safe)
  3. paymentProof dokazuje Payment(sessionId=sid, kind="rcpt1", sender=MPT Safe) na Gnosisu
     (izravno: storage/receipt proof; ili Merkle dokaz protiv rcpt1-root koji je ugovor zapamtio)
  4. sid nije već iskorišten
```

Potpis veže `recipient`, pa nema front-runninga: tko vidi transakciju u mempoolu, ne može
preusmjeriti claim na svoju adresu. Ključ se nikad ne otkriva na lancu.

Ako je isti `sid` plaćen više puta (dopušteno za `mpt`/`cmp`, vidi 0018_stray_resolver.sql),
pravo se računa po zbroju svih `rcpt1` eventa za taj `sid`. Konkretna pravila (zbroj ili prvi,
minimalni iznos) odlučuje ADR claim programa, ne ovaj.

## Model prijetnji

| Napad | Ishod |
|---|---|
| Napadač čita lanac ili izvod i zna `sid` | Nema ključ ni `salt`, pa ne može potpisati claim. |
| Napadač grinda ključ čiji digest daje tuđi `sid` | 2^120 pokušaja, neizvedivo. |
| MPT ili trgovac podmeće drugog vlasnika | `sid` je obveza na vlasnika, a uplatitelj ga je sam stavio u nalog. Promjena `sid`-a znači da uplata ne pripada tom intentu. |
| MPT bilježi `Payment` za `sid` koji nije plaćen | Forward bi morao stvarno prenijeti EURe s MPT Safe-a, pa krivotvorenje košta punu vrijednost. **Rezidualno povjerenje:** lanac dokazuje da je MPT router evidentirao uplatu, a ne da je banka primila novac od tog uplatitelja. Neovisni svjedok je Moneriumov order, koji nije javan. |
| Stray resolver pripiše tuđu uplatu `r1` intentu | Event nosi `rcpt1-unbound`, bez prava na claim (§3). |
| Front-running claima u mempoolu | Potpis veže `recipient` i `deadline`. |
| Zamjena QR-a (phishing): napadač podmetne QR sa svojim `sid`-om | Uplatitelj plaća napadačev intent, pa pravo dobiva napadač. Ublažava se tako da `sid` uvijek generira **uplatiteljev** preglednik na checkout stranici, a ne statični QR trgovca. Statični QR s iznosom koji upisuje uplatitelj ne daje potvrdu. |
| Krađa PDF-a (anonimna razina) | Kradljivac dobiva pravo. Ublažava se enkripcijom dijela B i preporukom razine wallet. |
| Kompromitiran uređaj uplatitelja | Izvan opsega, kao za svaki self-custody wallet. |
| Gašenje MPT-a | Provjera ne treba MPT: lanac, PDF i javni algoritam su dovoljni. Gubi se samo nadogradnja OTS dokaza, a ona se može napraviti i javnim OTS klijentom iz pending dokaza. |

## Privatnost i GDPR

- Na lanac i u OTS idu samo `sid`, iznos, primatelj i hashevi. Ime i IBAN uplatitelja **nikad**.
- Ime i IBAN uplatitelja ne ulaze u PDF iz backenda. PDF ih smije sadržavati samo ako ih je
  korisnik sam upisao lokalno, i takav PDF se ne sidri.
- `salt` sprječava vezanje poznate Safe adrese uz `sid`. Tko ima dio A potvrde, vidi tu vezu. Zato
  dio A treba dijeliti svjesno.
- Iznos i vrijeme su ionako javni u forward transakciji. Potvrda tu ne otkriva ništa novo.

## Promjene u kodu (procjena)

| Dio | Promjena |
|---|---|
| `backend/src/intents/sid.ts` | `isReceiptSid(sid)` (prefiks `r1`, duljina 26) |
| `backend/src/monerium/forward.ts` / `router/safe.ts` | `kind` = `rcpt1` ili `rcpt1-unbound` po §3 |
| `backend/src/intents/api.ts` | `GET /:sid/receipt`: forward tx hash, `logIndex`, blok, `kind`, OTS dokaz i Merkle put kad postoje |
| novi cron | dnevni Merkle korijen `rcpt1` potvrda → `registry.record` + OTS kalendari |
| migracija | tablica `receipt_anchors` (dan, korijen, tx hash, `.ots` blob) |
| checkout stranica i Flutter app | generiranje vlasnika i `sid`-a, PDF (pdf-lib), dio B, enkripcija lozinkom |
| wallet.domovina.ai | „Plati s potvrdom" koristi adresu aktivnog Safe-a kao `owner` |
| `docs/receipt-verification.md` | javni opis algoritma provjere, s primjerom |

Claim ugovor nije dio ove odluke.

## Faze

| Faza | Opseg | Ishod |
|---|---|---|
| 0 | Spike: generiranje `r1` sid-a + PDF u pregledniku, ručna provjera protiv postojećeg `Payment` eventa | dokaz da format stane u EPC opis i da Revolut i HR banke prenose `sid` netaknut |
| 1 | `kind = rcpt1/rcpt1-unbound`, `GET /:sid/receipt`, PDF na checkout stranici (anonimna razina) | prve potvrde u produkciji |
| 2 | razina wallet (Safe kao `owner`) | potvrde bez bearer tajne |
| 3 | dnevni Merkle korijen + OpenTimestamps | drugo, neovisno sidro |
| 4 | claim ugovor na Chiadu, pa na Gnosisu (zaseban ADR) | prvi stvarni claim |

## Otvorena pitanja

1. **Duljina opisa naloga.** `mpt:0x…?sid=` s 26 znakova je oko 75 znakova, što je unutar 140 za
   EPC. Treba provjeriti skraćuju li Revolut i HR banke opis ili mijenjaju velika i mala slova.
   Abeceda je samo s malim slovima pa je otporna na `upper()`, ali to treba potvrditi.
2. **CORS OpenTimestamps kalendara.** Ako preglednik ne može izravno pozvati kalendar, OTS
   stamp radi samo backend (faza 3), a pending dokaz se ne može dobiti odmah u PDF-u.
3. **Način `direct` (ADR 0017, migracija 0026).** Ako u tom načinu nema forwarda kroz MPT Safe,
   nema ni `Payment` eventa. Treba odlučiti daje li `direct` potvrdu i čime je sidri.
4. **Pohrana ključa za anonimnu razinu.** Je li dovoljno `localStorage` + PDF, ili ponuditi
   passkey PRF (WebAuthn `prf` ekstenzija) za enkripciju dijela B bez lozinke.
5. **`metadataURI`.** Za `rcpt1` ostaje prazan. Ako se ikad popuni, ne smije sadržavati podatke
   koji otkrivaju uplatitelja.
