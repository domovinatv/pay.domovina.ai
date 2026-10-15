# ADR 0023 — Nadogradnja potvrda o uplati iskustvima iz glasanja Maksimir: ključ iz 24 riječi i passkeyja, ulančani append-only zapis, javni checkpointi, neovisni verifikator, sidro bez novca, anonimni claim

- **Status:** Proposed (2026-10-12). Faze 1–3 implementirane i deployane 2026-10-12 (vidi „Implementacija“ na dnu).
- **Gradi na:** [0022](0022-potvrda-o-uplati-vezana-uz-kljuc-uplatitelja.md) (potvrde, deployano
  2026-10-12) · [0001](0001-no-server-side-recovery.md) (self-custody) ·
  [0005](0005-phase-5d-croatian-eid-attestation.md) (Certilia) ·
  [0006](0006-phase-5e-zkproof-anonymous-attestation.md) (ZK smjer) ·
  [0019](0019-off-cloud-forward-signer.md) (ključ koji pomiče novac ne smije raditi ništa drugo)
- **Izvor:** `~/git/stadion-maksimir/stadion-maksimir-natjecaj-2026` (MIT, isti autor), u
  produkciji od 25. 9. 2026.:
  - `docs/glasanje-kako-radi.md`: lanac hasheva, satni OTS snapshot, neovisna provjera, Semaphore
  - `docs/blockchain/adr/0001-kljuc-glasaca-passkey-i-24-rijeci.md` + `chain/client/keystore.ts`
  - `chain/contracts/v1/MaksimirGlasanjeV1.sol`: registrar + nullifier + bilo tko šalje
  - `scripts/maksimir_verify.py`, `scripts/maksimir_checkpoint.py`
  - `docs/blockchain/audit/nalazi.md` (A-01 … A-08, C-01, I-09)
- **Regresijski ugovor:** formula `r1` sida, oblik listova i API iz ADR 0022 ostaju isti.
  Postojeće potvrde (u produkciji 12. 10. 2026. ima 0 listova i 0 `r1` intenata) i dalje vrijede.

## Problem

ADR 0022 radi, ali ima pet slabih točaka koje je glasanje Maksimir već riješilo, u produkciji i
s auditom:

| # | Slabost u 0022 | Kako je riješio Maksimir |
|---|---|---|
| 1 | Anonimni ključ je **bearer**: sirov u `localStorage` i otisnut u dijelu B PDF-a. Izgubljen preglednik bez kopije znači izgubljeno pravo, a procurio PDF znači ukradeno pravo. Svaka potvrda ima svoj ključ, pa deset uplata znači deset kopija. | Jedna tajna od 32 B: **24 riječi (BIP-39)** za oporavak, **passkey PRF** samo omata tajnu za svakodnevno otključavanje. Omot je javno čitljiv i bez passkeyja beskoristan. |
| 2 | `receipt_leaves` se mogu tiho mijenjati ili brisati do dnevnog sidrenja, a sidra nisu međusobno povezana. Izbačeno sidro ili list nitko ne bi primijetio. | **Append-only lanac hasheva** (`prev_hash`, `seq` bez rupa), okidači u bazi odbijaju `UPDATE`/`DELETE`, a snapshot nosi i brojeve (glasači, bodovi), pa se vidi svaki skok. **Dnevni otkucaj** i kad se ništa ne događa. |
| 3 | `.ots` dokaz ostaje „pending" zauvijek, jer nadogradnju na Bitcoin nitko ne radi. Dokazi postoje samo u našoj bazi. | GitHub Action **bez tajni** svaki sat zapiše snapshot u javni repo, napravi `ots stamp` i `ots upgrade` za sve ranije, i vodi `index.json` s `"bitcoin": true`. |
| 4 | Provjera „bez MPT-a" postoji samo kao tekst u PDF-u. | `maksimir_verify.py`: samo standardna biblioteka, ne vjeruje ni bazi ni stranici, testiran i u obrnutom smjeru (izmijenjen listić daje exit 1). |
| 5 | Korijen na lanac čeka `PaymentRegistry`, koji nije deployan. Kad bude, upis korijena išao bi kroz Safe i Roles koji pomiču novac. | Vlastiti mali **ugovor bez nadogradnje**, nasljednik kao nova verzija, zamrznut izvor (`check-frozen`), mutacijsko testiranje. Operater na lanac upisuje samo ono što ne može naštetiti. |

Uz to Maksimir pokazuje kako bi izgledao **anonimni claim** iz ADR 0022 §6: Semaphore dokaz
„imam jednu od potvrda u ovoj grupi", s nullifierom po claim programu i primateljem kao porukom.

## Odluka

### 1. Jedan glavni ključ potvrda: 24 riječi + passkey PRF

Preuzima se model iz Maksimir ADR 0001, s vlastitim fiksnim vrijednostima:

| Vrijednost | Iznos | Trajna jer |
|---|---|---|
| tajna | 32 nasumična bajta = 24 riječi BIP-39 | oporavak svih potvrda |
| `rpId` | `domovina.ai` | isti passkey vrijedi za `mpt.`, `pay.`, `wallet.` |
| PRF sol | `sha256("mpt-receipt/keystore/v1")` | druga sol = nečitljivi omoti |
| HKDF | SHA-256, `info = "mpt-receipt-keystore-v1"` | isto |
| omot | AES-256-GCM, nasumičan IV, AAD = `credentialId` | omot vezan uz passkey |

Passkey **omata** tajnu, ne izvodi je, jer novi passkey (prelazak iPhone → Android) inače mijenja
sve ključeve. Omot živi u `localStorage` i u novoj tablici `receipt_keystore(credential_id_hash,
blob, created_at)`, čitljivoj svima, bez korisnika i bez sida. Preglednik bez PRF-a drži tajnu samo
za trajanje posjeta i traži 24 riječi.

Kôd se preuzima iz `chain/client/keystore.ts` (MIT, isti autor) uz bilješku o izvoru, a fiksne
vrijednosti se zamijene ovima iz tablice. Ovisnost `@scure/bip39` je ista kao u Maksimiru.

**Ključ po potvrdi izvodi se iz glavne tajne**, deterministički:

```
k_i    = HKDF(tajna, info = "mpt-receipt/key/"  ‖ i)  mod n   (0 ili ≥ n → sljedeći brojač)
salt_i = HKDF(tajna, info = "mpt-receipt/salt/" ‖ i)[0:16]
owner_i = adresa(k_i);   sid_i = r1 ‖ base32(keccak("MPT-RECEIPT-v1" ‖ owner_i ‖ salt_i))[0:24]
```

- Formula sida se ne mijenja, pa su potvrde s nasumičnim ključem (ADR 0022) i ove međusobno
  nerazlučive i jednako provjerljive.
- Svaka potvrda ima **drugu adresu vlasnika**, pa su javno nepovezive, kao i do sada.
- **Oporavak:** iz 24 riječi preglednik izvede `sid_0, sid_1, …` i pita `GET /api/intents/:sid/receipt`
  dok ne naiđe na 20 uzastopnih nepostojećih (gap limit kao BIP-44). Jedne riječi vraćaju sve
  potvrde na svakom uređaju.
- Brojač `i` raste lokalno. Na novom uređaju bez lokalnog brojača prvi slobodni `i` daje skeniranje.

**PDF više ne sadrži ključ.** Dio B postaje: „Ključ ovih potvrda je u vaših 24 riječi i u passkeyju
`<otisak ključa>`." Izvoz sirovog ključa jedne potvrde ostaje kao napredna opcija (npr. za predaju
prava drugoj osobi), uz upozorenje iz 0022.

Isti glavni ključ se kasnije može izvesti i za Semaphore identitet (§6), uz zasebnu HKDF oznaku.
Jedna kopija na papiru tako pokriva i potvrde i anonimni claim.

### 2. Append-only, ulančani zapis i brojevi u sidru

- **Okidači u D1 (SQLite):** `receipt_leaves` odbija `DELETE`, a `UPDATE` dopušta samo
  `anchor_id: NULL → vrijednost` i `name_mismatch` pri upisu. `receipt_anchors` odbija `DELETE` i
  izmjenu `root`, `seq`, `chain_head`, a dopušta samo dopunu `ots` i `chain_tx_hash`.
- **Lanac sidara:** svako sidro dobiva `seq` (bez rupa) i
  `chain_head = keccak256(abi.encode(prev_chain_head, seq, root, leaf_count, total_leaves, total_cents, lazy_count))`,
  gdje su `total_*` i `lazy_count` tekući zbrojevi od prvog sidra.
  Na OpenTimestamps i na lanac ide `chain_head`, ne sam korijen. Izbacivanje bilo kojeg starog
  sidra ili lista mijenja svaki kasniji `chain_head`.
- **Brojevi u sidru:** broj listova, ukupni iznos i broj naknadnih veza. Nagli skok (npr. masovno
  lažno lazy povezivanje) trajno je i javno zabilježen, kao broj glasača u Maksimir snapshotu.
- **Dnevni otkucaj:** sidro nastaje svaki dan i kad nema novih listova (`leaf_count = 0`, korijen =
  prethodni). Dokazuje da se ništa nije mijenjalo.

### 3. Javni checkpointi izvan MPT-a i nadogradnja OTS-a

Javni repozitorij `domovinatv/mpt-receipts-checkpoints` i GitHub Action **bez tajni**, jednom dnevno:

1. čita javni `GET /api/receipts/anchors/latest` (novi endpoint) i sve novije od zadnjeg u repou;
2. zapisuje `anchors/<seq>.json` (sortirani ključevi) i `.ots` iz MPT-a;
3. za svaki raniji `.ots` bez Bitcoin atestacije radi `ots upgrade`;
4. provjeri lanac `chain_head` od `seq 1` (ako se ne slaže, Action pada i to je javni alarm);
5. osvježi `index.json` (`seq`, `chain_head`, `bitcoin: true/false`) te napravi commit i push.

Repo čuva kopiju svih korijena i dokaza i kad MPT nestane. Stranica potvrde uz `.ots` s MPT-a
nudi i poveznicu na nadograđeni `.ots` iz repoa.

### 4. Neovisni verifikator

`scripts/mpt_receipt_verify.py`, samo Python standardna biblioteka (keccak-256 u čistom Pythonu,
jer `hashlib.sha3_256` nije keccak), ne vjeruje ni MPT-u ni stranici:

```sh
python3 scripts/mpt_receipt_verify.py mpt-potvrda-<sid>.json --checkpoints <klon repoa>/anchors/
```

Provjerava:

1. `sid` iz `owner` i `salt`;
2. ponovno izračunat `leaf_hash` svakog retka;
3. Merkle dokaz do korijena;
4. korijen → `chain_head` sidra → isti `chain_head` u javnom checkpointu, i neprekinut lanac do njega;
5. da `.ots` fajl žigoše baš taj `chain_head` (za Bitcoin atestaciju upućuje na `ots verify`);
6. po izboru, forward tx na Gnosisu preko **najmanje dva neovisna RPC-a** (Maksimir C-01: klijent
   ne smije vjerovati jednom RPC-u).

Test u oba smjera: ispravna potvrda daje exit 0, a izmijenjen iznos, list ili sidro daje exit 1 s
popisom grešaka.

### 5. Sidro na Gnosisu kroz zaseban ugovor, ne kroz PaymentRegistry

`MptReceiptAnchorV1` (oko 60 linija):

```
append(uint64 seq, bytes32 chainHead, bytes32 root, uint32 leafCount, uint64 totalCents)
  - samo `anchorer`; seq == last + 1; chainHead mora odgovarati keccaku iz §2 nad zapamćenim prethodnim
  - event Anchored(seq, chainHead, root, leafCount, totalCents)
  - rootSeen[root] = seq   (za claim ugovore: Merkle dokaz protiv zapamćenog korijena)
```

- `anchorer` je zaseban EOA s nešto xDAI-ja i **bez ikakve ovlasti nad novcem**. Nije router, nije
  u Zodiac Roles i nije Safe (ADR 0019: ključ koji pomiče novac ne radi ništa drugo).
- Ugovor ne provjerava sadržaj: provjerava samo `seq` i ulančavanje, pa operater ne može
  prepisati povijest ni na lancu.
- Nema proxyja ni pauze. Nova verzija je novi ugovor; izvor se zamrzava kao u Maksimiru
  (`deployments/<mreža>/v1.json` + provjera zamrznutog izvora u CI-ju).
- Ovo uklanja ovisnost sidrenja o `safe-tx/004`. `kind = rcpt1` u `Payment` eventu i dalje čeka
  PaymentRegistry, ali izravna potvrda više ne ovisi o njemu: list je u sidru na lancu.

### 6. Anonimni claim kroz Semaphore (smjer za claim ADR)

Za program koji želi da se ne vidi koja je uplata dala pravo:

1. Vlasnik potvrde izvede Semaphore identitet iz glavne tajne (§1) i potpiše ključem potvrde
   `Join{program, commitment}`.
2. MPT provjeri potpis i potvrdu, pa upiše `commitment` u grupu programa (jednu grupu po pragu
   iznosa, npr. „≥ 5 € kampanji X", jer Semaphore dokazuje članstvo, a ne iznos). Svaka potvrda
   ulazi u grupu najviše jednom.
3. Claim je Semaphore dokaz s `message = primatelj` i `scope = program`. Nullifier daje jedan claim
   po članu, a primatelj u poruci sprečava preuzimanje dokaza u mempoolu. Transakciju šalje bilo
   tko, kao u `MaksimirGlasanjeV1`.

Iskrene granice, iste kao u Maksimiru:

- **Prema MPT-u veza nije skrivena.** MPT zna koja je potvrda upisala koji commitment. Javnost to
  ne vidi. Rješenje su slijepe vjerodajnice (Maksimir korak 5, ADR 0006), koje ovdje ne rješavamo.
- **Mala grupa skriva malo.** Uz svaki dokaz prikazuje se veličina grupe.
- **Trusted setup** je javna PSE ceremonija za Semaphore v4; vlastiti krug traži novu.

### Što se ne preuzima

| Iz Maksimira | Zašto ne |
|---|---|
| MACI (tajni listić) | nema use-casea; potvrda je po definiciji dokaz, ne tajna |
| satni ritam | uplate su rjeđe od glasova; dnevni ritam + sidro na zahtjev je dovoljno |
| registrar potpisuje pravo (eOsobna) | „imenovana potvrda" (jedna osoba = jedan claim) je zaseban slučaj; ide kroz ADR 0005 kad ga neki program zatraži |
| javna objava s imenom | potvrda o uplati nije izjava; ime uplatitelja ne ide nikamo (ADR 0022, GDPR) |

## Model prijetnji (razlika prema 0022)

| Napad | 0022 | 0023 |
|---|---|---|
| Ukraden ili procurio PDF | kradljivac dobiva pravo | PDF nema ključ |
| XSS ili ekstenzija čita `localStorage` | sirov ključ | samo omot; tajna je otvorena samo u trenutku potpisa |
| Izgubljen uređaj bez kopije | pravo izgubljeno | 24 riječi vraćaju sve potvrde |
| Procurjelih 24 riječi | — | sve potvrde su kompromitirane; riječi se čuvaju kao seed fraza |
| Operater tiho briše ili mijenja list prije sidrenja | moguće | okidači odbijaju; zaobilaženje (izravni SQL kao admin D1) i dalje moguće do sljedećeg sidra, ali tada mijenja brojeve |
| Operater izbaci staro sidro | nevidljivo | lanac `chain_head` puca; javni repo i ugovor ga drže |
| MPT nestane | `.ots` ostaje pending | nadograđeni `.ots` i svi korijeni u javnom repou; korijeni i na Gnosisu |
| Kompromitiran ključ za sidrenje | — | može dodati lažno sidro, ali ne prepisati staro; ne može pomaknuti novac |
| Zlonamjeran kôd stranice | krade ključ | **i dalje može** dok je tajna otvorena: granica svakog rješenja s ključem u pregledniku (Maksimir 06) |

## Faze

| Faza | Opseg | Ovisi o |
|---|---|---|
| 1 | okidači, `seq` + `chain_head` + brojevi u sidru, dnevni otkucaj, `GET /anchors/latest` | — |
| 2 | `mpt_receipt_verify.py` + test u oba smjera | 1 |
| 3 | javni repo checkpointa + Action s `ots upgrade` | 1 |
| 4 | glavni ključ: 24 riječi + passkey PRF, izvođenje po potvrdi, oporavak skeniranjem, PDF bez ključa | — |
| 5 | `MptReceiptAnchorV1` na Chiadu, pa na Gnosisu; `anchorer` EOA | 1 |
| 6 | anonimni claim (Semaphore), zajedno s claim ADR-om | 4, 5 |

Faze 1–3 su male i odmah zatvaraju najveći jaz (provjerljivost bez nas). Faza 4 je najvažnija za
korisnika i treba je napraviti prije nego što potvrde dobiju stvarnu vrijednost.

## Otvorena pitanja

1. **Jedan passkey za wallet i potvrde?** Isti `rpId`, ali wallet passkey potpisuje (P-256 owner
   Safe-a), a ovaj samo omata. Dva passkeyja su jasnija; jedan je lakši. Treba odlučiti uz ADR 0013.
2. **Smije li anonimna razina nestati?** Ako korisnik ima wallet, potvrda može ići na Safe (razina
   wallet iz 0022) i ova razina je suvišna. Za uplatitelje bez walleta ostaje.
3. **Ritam sidrenja na lancu:** dnevno ili na zahtjev (kad korisnik želi potvrdu odmah)? Gas na
   Gnosisu je zanemariv; ograničenje je samo spam.
4. **Gap limit 20** pretpostavlja da korisnik ne stvori više od 20 neplaćenih `r1` intenata
   zaredom. Neplaćeni intent se ne vidi kao potvrda, pa skeniranje mora brojiti i intente koji
   postoje, ne samo plaćene.

## Implementacija faza 1–3 (grana `feat/receipts-0023-faze-1-3`)

| Faza | Gdje |
|---|---|
| 1 | migracija `0028_receipt_anchor_chain.sql` (sidro po `seq`, `chain_head`, tekući zbrojevi, 4 okidača), `backend/src/receipts/anchor.ts` (sidro i listovi u jednoj D1 transakciji, `seq` je latch, heartbeat), `GET /api/receipts/anchors[?after=N]`, `/latest`, `/:seq`, `/:seq.ots` |
| 2 | `scripts/mpt_receipt_verify.py` (samo stdlib, keccak u čistom Pythonu); `backend/test/receiptVerify.test.ts` pokreće ga u oba smjera |
| 3 | `tools/receipt-checkpoints/`: predložak javnog repoa `domovinatv/mpt-receipts-checkpoints` (`checkpoint.py`, Action u 00:40 UTC, README). Repo još nije stvoren |

**Nalaz verifikatora (12. 10. 2026.):** `deriveReceiptSid` je `viem.concat`-u davao mješavinu
`Uint8Array` i hex stringova, pa su slova a–f adrese i salta postajala 0 (90 bajtova umjesto 50) i
vezanje sida uz vlasnika bilo je oslabljeno. U produkciji tada nije bilo nijednog `r1` intenta.
Ispravljeno u istoj grani; zlatni vektor je `r183ns4pcpn659hd2z3xtaqiwq` i jednak je u TS-u, u
pregledničkom bundleu i u Pythonu. To je točno ona vrsta greške zbog koje Maksimir ima neovisni
verifikator.


## Dopuna (2026-10-12): javni repo nije izvor istine

Pitanje: što ako netko (GitHub, ukraden token ili mi) prepiše povijest repoa
`mpt-receipts-checkpoints`? Odgovor: sigurnost ne smije ovisiti o Git povijesti, nego o
Bitcoinu, a repo služi samo dostupnosti. Zato:

1. **Verifikator provjerava Bitcoin vrijeme** (`--btc-api`, Esplora API, npr. mempool.space i
   blockstream.info, koji se moraju slagati). `.ots` se parsira i izvršava do Bitcoin
   atestacije, zaglavlje bloka se provjerava (hash i merkle root), a vrijeme bloka mora biti
   između `created_at − 2 h` i `created_at + 48 h`. Lanac krivotvoren naknadno ima mlađe dokaze
   i pada.
2. **Potvrda nosi svoj `.ots`** (`payments[].anchor.ots`, `ots_bitcoin`). Worker na svakom
   6-satnom ticku iz javnog repoa povuče dokaz koji je Action nadogradio na Bitcoin. Prihvaća ga
   samo ako žigoše isti `chain_head` i ima Bitcoin atestaciju. Svaki uplatitelj je tako neovisan
   svjedok originalnog lanca, bez repoa i bez MPT-a.
3. **Ruleset na `main`** (`non_fast_forward` + `deletion`) štiti od ukradenog tokena i greške.
   Admina ne zaustavlja, i to je prihvatljivo: svaki klon, fork i potvrda drži originalni lanac.
4. **Software Heritage**: Action nakon svakog commita traži arhiviranje, pa postoji neovisna
   kopija izvan GitHuba.

## Vezani dokumenti

- [Dnevnik izvedbe 12. 10. 2026.](../2026-10-12-potvrde-o-uplati-dnevnik.md): mjerenja, zamke, nesigurni prozor, otvoreno
