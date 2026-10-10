# HUB3 PDF417: provjera našeg formata naspram stvarnih računa i specifikacije

Provjera 2026-10-10. Cilj: smijemo li MPT intent nuditi i kao HUB3 barkod uplatnice
(uz EPC QR), da se isproba Aircash „Slikaj i plati" → Monerium (vidi [README](README.md)).

## Izvori

- **Specifikacija:** HUB, „HUB 3A obrazac — specifikacija PDF417 barkoda", verzija 6, rujan 2022
  (`hub.hr/sites/default/files/inline-files/2DBK_EUR_Uputa_1.pdf`).
- **Četiri stvarna računa** iz Matijinog sandučića (KEKS Pay režije i e-računi), dekodirana
  zxing-cpp i Apple Vision dekoderom. Podaci platitelja i referenca kupca ovdje su zamijenjeni.

| Izdavatelj | Kraj zapisa | Polje 13 | Dijakritike | Napomena |
|---|---|---|---|---|
| VG Čistoća (KEKS Pay) | `…opis\n` (LF iza 14. polja) | prazno | ne (`CISTOCA`) | polja rezana na točnu duljinu (`VELIKA GORICA,10410 VELIKA ` = 27) |
| HEP-Opskrba | `…opis\n` | `ELEC` | ne | — |
| Telemach | `…opis\r\n` (**CRLF**) | `OTLC` | ne | ECL ~2 %, banke ga ipak čitaju |
| e-račun (Ekipa Products → ITalk) | bez završnog LF | `COST` | ne | — |

Zaključak iz uzoraka: skeneri su tolerantni (CRLF, bez završnog LF, niski ECL), ali **nitko
ne koristi dijakritike** i svi poštuju duljine polja.

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

Flutter generator nisam mijenjao: postojeći testovi (`test/widget_test.dart`) fiksiraju 14 redaka
bez završnog LF, pa je F3 promjena ponašanja (`behavior-change`), a F1 traži drugi renderer.
Za intente HUB3 sada sastavlja rail.

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
