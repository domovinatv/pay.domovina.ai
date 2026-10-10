# HUB3 PDF417: provjera našeg formata naspram stvarnih računa i specifikacije

Provjera 2026-10-10. Cilj: smijemo li MPT intent nuditi i kao HUB3 barkod uplatnice
(uz EPC QR), da se isproba Aircash „Slikaj i plati" → Monerium (vidi [README](README.md)).

## Izvori

- **Specifikacija:** HUB, „HUB 3A obrazac — specifikacija PDF417 barkoda", verzija 6, rujan 2022
  (`hub.hr/sites/default/files/inline-files/2DBK_EUR_Uputa_1.pdf`).
- **Osam stvarnih računa** iz Matijinog sandučića (KEKS Pay režije i e-računi), dekodirana
  zxing-cpp i Apple Vision dekoderom. Podaci platitelja i referenca kupca ovdje su zamijenjeni.

| Izdavatelj | Kraj zapisa | Polje 13 | Dijakritike | Napomena |
|---|---|---|---|---|
| VG Čistoća (KEKS Pay) | `…opis\n` (LF iza 14. polja) | prazno | ne (`CISTOCA`) | polja rezana na točnu duljinu (`VELIKA GORICA,10410 VELIKA ` = 27) |
| HEP-Opskrba | `…opis\n` | `ELEC` | ne | — |
| Telemach | `…opis\r\n` (**CRLF**) | `OTLC` | ne | ECL ~2 %, banke ga ipak čitaju |
| e-račun (Ekipa Products → ITalk) | bez završnog LF | `COST` | ne | — |
| VG Čistoća, rujan | `…opis\n` | prazno | ne | isti oblik kao kolovoz |
| HEP-Opskrba, rujan | `…opis\n` | `ELEC` | ne | isti oblik kao kolovoz |
| VG Vodoopskrba | `…opis \n` (razmak na kraju opisa) | `WTER` | **da** (`STEPANIĆ`, `GRAĐANI`) | adresa primatelja **32 znaka** (spec 25) |
| Dječji vrtić (račun 26/…) | `…opis\n` | prazno | **da** (`Školska`, `SMENDROVIĆEVA`) | model `HR64` |

Zaključak iz uzoraka: skeneri su tolerantni (CRLF, bez završnog LF, niski ECL, pa i adresa
preko duljine polja). Dva izdavatelja pišu dijakritike kao UTF-8 i Apple Vision ih i ondje
vraća kao mojibake (`STEPANIÄ`), dakle bankovne aplikacije same dekodiraju bajtove. Pisanje
bez dijakritika je zato najsigurnije za sve dekodere. Svih 8 se čita i u zxing i u Visionu.

## Što generira RBA biz iOS („Generiraj uplatnicu“, 2026-10-11)

Dva izlaza za isti primjer (ITalk d.o.o., HPB `HR41…`):

| | PDF `HUB3APaySlip.pdf` | Slika za dijeljenje (WhatsApp) |
|---|---|---|
| Simbologija | **PDF417** na obrascu HUB 3A | **QR kod** (ECC Q) s istim HUB3 tekstom |
| Polja | 14, LF iza svakog | 14, LF iza svakog |
| Platitelj | popunjen (naziv / adresa / sjedište) | prazan |
| Primatelj | VELIKA SLOVA, s dijakritikom (`IX. JUŽNA OBALA 20`) | isto |
| Rezanje | na duljine iz spec v6 (opis točno 35), **bez trimanja** razmaka na kraju | opis 35 |
| Poziv na broj / namjena | `HR00` `619283636373` / `AIRB` | `HR00` `19911118` / prazno |

- RBA reže polja točno kao naš generator, ali ostavlja razmak na kraju odrezanog polja
  (`ja sam sjediste platitelja `) i ne mijenja velika/mala slova. Mi trimamo i ne diramo velika slova.
- Dijakritike kao UTF-8 bez ECI: zxing ih iz PDF417 čita ispravno, iz QR-a kao `JUÅ½NA`, a
  Apple Vision u oba kao mojibake. Naše pisanje bez dijakritika izbjegava problem.
- **RBA za dijeljenje koristi QR, ne PDF417** — znači da hrvatske bankovne aplikacije
  prihvaćaju `HRVHUB30` tekst i u QR kodu. To je moguća treća varijanta za checkout
  (jedan QR za HR aplikacije, uz EPC QR za Revolut).
- Obrazac na papiru za platitelja ispisuje model `HR99`, ali to polje nije u barkodu.

**Zaključak:** naš format je usklađen s RBA-om u svemu što je bitno (14 polja, završni LF,
duljine polja, redoslijed, prazna namjena). Razlike (velika slova, dijakritike, trailing razmak)
su stil izdavatelja i skeneri ih toleriraju u oba smjera.

## Pokusi skeniranja (2026-10-11)

| Kod | Primatelj | PBZ iOS | HPB biz iOS | RBA biz iOS | Aircash |
|---|---|---|---|---|---|
| PDF417 s pay.domovina.ai (Flutter, nakon ispravka #75) | ITalk, **HPB `HR…`** | čita | čita | čita | **čita i prihvaća** |
| HUB3 PDF417 s rail checkouta / energy | ITalk, Monerium **`EE…`** | čita, **odbija** | čita, **odbija** | čita, **odbija** | čita, odbija: „Unknown code. Try again.“ |
| EPC QR s rail checkouta | ITalk, Monerium `EE…` | — | — | — | čita, odbija |

**Svi skeneri čitaju kod, ali nijedna aplikacija ne pušta uplatnicu (HUB3) kojoj IBAN primatelja
nije hrvatski.** S HR IBAN-om rade sve četiri. HUB3 je u praksi „domaći nalog“: aplikacije ga
vežu uz `HR` IBAN (spec opisuje samo hrvatski IBAN), a Aircash uz to ima i popis država (§11.1).
Format koda nije problem. Varijanta A iz
[README](README.md) (HR naplatni IBAN) tehnički radi već danas.

**Posljedica:** HUB3 kartica s Monerium `EE…` IBAN-om (checkout, energy `/beta/`) nikome ne
pomaže dok naplatni IBAN nije hrvatski.

**Prilika na hrvatskom tržištu:** svaka hrvatska bankovna aplikacija i Aircash čitaju HUB3, a
većina građana plaća režije upravo tako. Kanal se otvara čim primatelj ima **hrvatski IBAN**:
- vlastiti HR naplatni račun tenanta + AIS uparivanje (varijanta A; za MPT u ime trećih
  vrijedi Monerium BToS §16 — vidi `docs/compliance/`);
- Monerium IBAN s `HR` prefiksom, ako ga Monerium može izdati (pitanje za Monerium);
- partner s HR IBAN-ima: Aircash (EMI, HNB) ili hrvatska banka kao izdavatelj IBAN-a s
  automatskim mintom, odnosno model M1/M4 iz [04](04-zasto-aircash-suradnja.md).

## Pravila iz specifikacije koja su bitna

- 14 polja, „**nakon zadnjeg znaka u polju stavlja se graničnik**" LF — i iza 14. polja.
- Duljine: primatelj 25, adresa 25, mjesto 27, IBAN 21, model 4, poziv na broj 22, namjena 4, **opis 35**.
- Znakovi: znamenke, hrvatska abeceda, Q W X Y, razmak i `, . : - + ? ' / ( )`. **`=`, `&`, `_`, `@` nisu dopušteni.**
- IBAN polje opisuje samo hrvatski IBAN (21 znak); `EE…` (20) stane, ali nije pokriven tekstom.
- PDF417: modul 0,254 mm, visina:širina modula 3:1, **ECL 4, 9 stupaca, binarno kodiranje**, UTF-8.

## Nalazi o našem kodu

### Flutter generator (`lib/models/hub3_payload.dart`, `lib/ui/home_page.dart`)

| # | Nalaz | Težina |
|---|---|---|
| F1 | **Dart `barcode` 2.2.9 PDF417 za HUB3 duljine zxing ne čita.** Apple Vision čita svih 16 testnih simbola, zxing-cpp tek pokoji, i to nasumično po duljini (nije rasterizacija: isto na 100/300 DPI i s binarizacijom; nije visina). Isti tekst iz pdf417gen ili bwip-js zxing čita. Dakle iOS aplikacije rade, Android aplikacije sa zxing dekoderom vjerojatno ne. | **Visoka** |
| F2 | Opis `gnosis:0x…?sid=…` ima 49+ znakova (max 35) i sadrži `=` (nije dopušten). Uz to je `gnosis:` od ADR 0016 samo dijagnostički prefiks — takva uplata se parkira. | Visoka (funkcionalno) |
| F3 | Nema završnog LF iza 14. polja (spec ga traži; uzorci pokazuju da banke toleriraju oboje). | Niska |
| F4 | Nema rezanja na duljine polja ni čišćenja znakova; dijakritike idu kao UTF-8 bez ECI pa ih Vision vraća kao mojibake (`JuÅ¾na`). | Srednja |
| F5 | PDF417 parametri: ECL 2 (spec 4), broj stupaca po omjeru (spec 9), widget fiksne veličine 420×110. | Niska (uzorci pokazuju toleranciju) |

**Ispravljeno (2026-10-11):**

- **F1 — uzrok pronađen:** `_getLeftCodeWord`, klaster 0 računa `(rows - 3) ~/ 3` umjesto
  `(rows - 1) ~/ 3` (ISO/IEC 15438). Lijevi i desni indikator retka se ne slažu kad je
  `rows % 3 ≠ 0`; Vision čita samo jednu stranu, zxing ih uspoređuje i odbija simbol.
  Bug je i na upstream masteru. Paket je vendoran u `third_party/barcode` s jednolinijskom
  ispravkom (`PATCHES.md`, `dependency_overrides`). Nakon ispravka zxing čita 26/26 duljina.
- **F2–F4:** `Hub3Payload` sada radi kao rail — LF iza svakog polja, rezanje na duljine,
  dopušteni znakovi, bez dijakritika. Opis je `MPT sid:<sid>` (HR IBAN put ne ide kroz Monerium).
- **F5:** renderer na ECL 4 i modul 3:1.

### Rail (`backend/src/intents/hub3.ts`, novo)

`buildHub3Text` po spec v6: LF iza svakog polja, duljine, dopušteni znakovi, bez dijakritika,
`HR99` bez reference, `OTHR`, IBAN > 21 znak → `null`. Odgovor intenta dobiva aditivno polje
`hub3_data` uz `epc_qr_data`. Testovi u `backend/test/hub3.test.ts` uključuju oblik stvarnog HEP računa.

**Routing:** `mpt:0x<adresa>?sid=<sid>` ima ~60 znakova i ne stane ni u opis (35) ni u poziv na
broj (22). Uz to banke za HR → EE plaćanje opis ne šalju. Zato HUB3 opis **namjerno nema sid**:
uplata stiže kao „zalutala" i stray resolver (ADR 0018) je veže po tenantu, točnom iznosu i
vremenu. Sid bez adrese bio bi gori: takav memo nije zalutao, a nije ni routabilan pa se parkira.
Ako pokus uspije, sljedeći korak je routing po sid-u bez adrese (adresa iz `payment_intents`,
kao kod stray resolvera) ili numerička referenca intenta u pozivu na broj.

### Renderer na klijentu (energy.domovina.ai)

bwip-js 4.11.4, `pdf417` s `columns: 9, eclevel: 4, rowmult: 3`. Provjereno: zxing-cpp i Apple
Vision čitaju na 72, 150 i 300 DPI.

## Kako ponoviti

```bash
# PDF → slika → dekoder (zxing-cpp + PyMuPDF u venv-u)
python -I decode.py uplatnica.pdf
# Apple Vision (isti dekoder kao iOS): VNDetectBarcodesRequest, symbologies = [.pdf417]
```

Skripte su bile u scratchpadu sesije; logika je 20 redaka: PyMuPDF `get_pixmap(dpi=300)` →
`zxingcpp.read_barcodes(img)`, te Swift `VNImageRequestHandler(cgImage:).perform([req])`.
