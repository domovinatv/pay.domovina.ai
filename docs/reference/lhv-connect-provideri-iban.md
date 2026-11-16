# Katalog: LHV Connect klijenti i njihovi IBAN-i

Živi katalog, stanje 2026-11-16. Služi ADR-u [0032](../decisions/0032-visestruki-izvori-priljeva.md):
iz IBAN-a primatelja (ili platitelja) treba znati koji je provider iza računa, pa time i koji adapter
dojavljuje priljev. Popis klijenata dolazi iz
`pinkainc/open-banking/docs/research/2026-10-23-lhv-connect-clients-and-feasibility.md`, LHV
rasponi iz lokalnog mirrora `pinkainc/docs.lhv-connect`, a IBAN-i providera iz njihovih javnih
help stranica (izvori dolje).

Kad netko pošalje stvarni IBAN koji ovdje fali (snimka iz aplikacije, uplatnica), upiši ga u
tablicu s datumom i izvorom. Ne izmišljaj primjere: nepoznato ostaje „nepoznato”.

## Pravila prepoznavanja (otisak IBAN-a)

Estonski IBAN je `EEkk bbxx xxxx xxxx xxxx`; `bb` (znakovi 5–6) je šifra banke. LHV Pank je `77`.

| Oblik | Značenje | Primjer | Izvor |
|---|---|---|---|
| `EEkk 7777 000x xxxx xxxx` | **LHV virtualni IBAN (VIBAN)**, otvara ga service provider kroz LHV Connect (`POST /viban/open`) za svog korisnika | `EE71 7777 0002 0001 4007` (LHV dokumentacija), `EE70 7777 0001 6292 1128` (Monerium, ITalk) | LHV Connect docs, naš tenant `italk` |
| `EEkk 7700 771x xxxx xxxx` | Obični LHV Pank račun (master račun klijenta ili fizička/pravna osoba) | `EE33 7700 7710 0126 0958` (LHV docs), `EE80 7700 7710 0402…` (Wiseov vlastiti EUR račun) | LHV Connect docs, Wise help |
| `GBkk LHVB 0403 xxxx xxxx` | LHV Bank (UK), sort code `04-03-xx` | `GB20 LHVB 0403 1512 3456 78` (LHV docs) | LHV Connect docs (UK) |
| `BEkk 967x xxxx xxxx` | **Wise Europe SA**, BIC `TRWIBEB1XXX`; nije LHV | `BE79 9670 40…` (Wiseov vlastiti) | Wise help |

Posljedice za MPT:

- **`EE..7777` ne kaže koji je provider**, samo da je VIBAN pod nekim LHV Connect klijentom.
  Vlasnika VIBAN-a zna samo LHV (i taj klijent). Za naše tenante vlasnik je poznat jer IBAN dolazi
  iz `receiving_accounts` / Monerium `listIbans`, ne iz otiska.
- **Hipoteza: znakovi 9–12 (`0001`) označavaju LHV Connect klijenta.** Oba poznata Monerium IBAN-a
  (ITalk KYB i Bleap osobni, dva različita Monerium profila) imaju `7777 0001`, a primjer iz LHV
  dokumentacije `7777 0002`. Ako vrijedi, `EE..7777 0001` = Monerium i otisak bi otkrivao providera.
  Dvije točke nisu dokaz: potvrditi IBAN-om drugog providera (TransferGo, Lightyear) ili pitati LHV.
- **`BE..967` je Wise**, i ne ide kroz LHV. Wise adapter (ADR 0032, korak 5) ne ovisi o LHV-u.
- Monerium **sandbox** IBAN-i (`EE11 7863…`, `EE51 4996…`, primjer iz docs `EE52 1273…`) nisu u
  LHV rasponu; otisak vrijedi samo za produkciju.

## Katalog po provideru

Pouzdanost: **potvrđeno** = službena stranica providera ili LHV-a; **vjerojatno** = priopćenje ili
treća strana; **nepoznato** = nema javnog izvora (IBAN se vidi samo u prijavljenoj aplikaciji).

| Provider | IBAN koji korisnik dobije (EUR) | BIC | Institucija | Na LHV-u danas? | Po korisniku? | Pouzdanost |
|---|---|---|---|---|---|---|
| **Monerium** (EURe) | `EE..7777 0001…` | `LHVBEE22` | LHV Pank | da | da, IBAN po adresi/profilu | potvrđeno: ITalk KYB `EE70 7777 0001 6292 1128` i Bleap osobni račun `EE85 7777 0001 68…` (2026-11-16) |
| Bleap (preko Moneriuma) | isto kao Monerium, `EE..7777 0001…` | `LHVBEE22` | LHV Pank (Monerium VIBAN) | da | da | potvrđeno (stvarni račun, 2026-11-16) |
| **Wise** | `BE..967…` | `TRWIBEB1XXX` | Wise Europe SA, Bruxelles | **ne** | da | potvrđeno |
| Wise, vlastiti račun | `EE80 7700 7710 0402…` | `LHVBEE22` | LHV Pank | da | ne, Wiseov ulazni račun | potvrđeno da postoji; namjena nije navedena |
| Wise (GBP) | sort code `23-14-xx`, ne IBAN | – | Wise (UK) | ne | da | potvrđeno |
| **TransferGo** (EUR) | `EE..` VIBAN; segment `7777` vjerojatan, nije objavljen | `LHVBEE22` (nije navedeno) | LHV Pank | da | da | potvrđeno izdavatelj, segment nepoznat |
| TransferGo (GBP) | sort code + račun, VIBAN | – | LHV Bank Ltd | da | da | potvrđeno izdavatelj |
| **Lightyear** | `EE..` osobni IBAN pri LHV-u; **prelazi na `DE..` kod Citija** (najava 16. 9. 2026., datum prelaska nepoznat) | nepoznato | LHV Pank → Citi | u prelasku | da | potvrđeno preseljenje, format nepoznat |
| **B4B Payments** | LHV VIBAN (od 2020.), format nije objavljen | – | LHV | vjerojatno | – | vjerojatno |
| **Montonio** | LHV VIBAN + safeguarding | – | LHV | vjerojatno | – | vjerojatno |
| **Tuum** | preprodaje LHV VIBAN, račune i FX (od 2021.) | – | LHV (UK) | vjerojatno | ovisi o klijentu | vjerojatno |
| **Coinbase** | vidi se samo u aplikaciji; uplata traži jedinstvenu referencu | nepoznato | nepoznato | nepoznato | po računu + referenca | nepoznato |
| **Blockchain.com** | vidi se samo u aplikaciji | nepoznato | nepoznato | nepoznato | nepoznato | nepoznato |
| **Bitstamp** | nema javnog izvora | nepoznato | nepoznato | nepoznato | nepoznato | nepoznato |
| **Airwallex** | „namjenski europski IBAN na ime tvrtke”, država nije objavljena | nepoznato | nepoznato | nepoznato | da | nepoznato |
| Currencycloud, Paysafe (Skrill, Neteller), Trustly, TrueLayer, Monese, Railsr, Single.Earth | nema javnog izvora o IBAN-u ni o tome jesu li još na LHV-u | – | – | nepoznato | – | nepoznato |

## Povijest i napomene

- **Wise:** od 2017. korisnici su imali `DE..` IBAN-e; u prosincu 2019. uvedeni `BE..` (Wise Europe
  SA), stari istekli u srpnju/kolovozu 2020. Nijedan izvor ne stavlja IBAN-e Wiseovih korisnika
  na LHV. LHV je Wiseova banka za vlastite račune, ne izdavatelj korisničkih IBAN-a. Zato Wise
  priljev vidimo samo kroz Wiseov webhook, nikad kroz LHV.
- **TransferGo:** EUR VIBAN izdaje LHV Pank, GBP VIBAN LHV Bank Ltd, PLN/USD Santander Polska.
  Članak „collecting bank accounts are changing” nije bio dostupan (403): provjeriti mijenja li banku.
- **Lightyear:** EUR/GBP prelaze s LHV-a na Citi; stari osobni IBAN radi u prijelaznom razdoblju.
- **Coinbase, Blockchain.com, Bitstamp:** treba stvarni IBAN iz aplikacije. Provjeri znakove 5–8:
  `7777` znači LHV VIBAN.
- LHV javno kaže da ima „preko 100” do „gotovo 200” fintech klijenata, a imenom navodi samo
  Airwallex, TransferGo, B4B Payments, Montonio, Tuum i Form3.

## Kako popuniti praznine

1. Snimka ekrana „uplati EUR” iz aplikacije (Coinbase, Blockchain.com, Bitstamp, Airwallex,
   Lightyear) od nekoga tko ima račun. Dovoljni su prvih 8 znakova i BIC.
2. Po potrebi IBAN validator s nazivom banke (bez slanja punog tuđeg IBAN-a vanjskom servisu).
3. Kad ITalk dobije LHV sandbox (zatražen 2026-10-30): `POST /viban/info` za strukturu VIBAN-a.

## Izvori

- LHV Connect dokumentacija, lokalni mirror `pinkainc/docs.lhv-connect` (2026-10-23), VIBAN usluge
- https://wise.com/help/articles/2932124/wise-account-details
- https://wise.com/help/articles/2827505/how-do-i-use-my-eur-account-details
- https://wise.com/gb/blog/new-eur-bank-details
- https://www.transfergo.com/en?p=841888
- https://lightyear.com/et-ee/blog/lightyear-citi-koostoo (16. 9. 2026.)
- https://www.finextra.com/pressarticle/94819/lightyear-chooses-lhv-to-power-instant-eur-payments
- https://www.finextra.com/pressarticle/90025/lhv-uk-joins-forces-with-tuum
- https://www.b4bpayments.com/c/blog/b4b-payments-chooses-lhv-banking-service
- https://www.crowdfundinsider.com/?p=209092 (Montonio)
- https://www.airwallex.com/uk/products/global-accounts/euro-account
- https://help.coinbase.com/en/exchange/trading-and-funding/funding-your-account-with-eur
- https://support.blockchain.com/hc/en-us/articles/4413613480340-How-can-I-deposit-EUR-SEPA-
