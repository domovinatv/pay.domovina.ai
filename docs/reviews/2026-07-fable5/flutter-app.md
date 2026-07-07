# Flutter app — nalazi (FL-*)

Podsustav: `lib/`, `test/` (macOS+Web POS/QR). Pokriveno finderom `flutter-app`.
`flutter analyze` = 0 issues (ground check).

> **Invarijanta:** EPC strogi 10-linijski layout i HUB3 14-polja su NAMJERNI —
> nijedan nalaz ne dira layout. FL-02/FL-04 se tiču **duljine polja / validacije
> iznosa** (korektnost sadržaja), ne layouta.

---

## FL-01 [MONEY-BUG (POS)] `sid` se ne rotira nakon završenog plaćanja

**file:** `lib/ui/home_page.dart:62`

**Failure scenarij:** POS mod zadrži isti `sid` nakon što je plaćanje potvrđeno.
Za NOVU prodaju QR nosi stari `sid` koji već ima `paid` intent → status poll
odmah vrati "Primljeno ✓" iako novi kupac nije platio ništa. Trgovac isporuči
robu na temelju lažnog "plaćeno".

**Fix:** Rotirati `sid` (novi UUID + novi intent) na početku svake nove prodaje /
nakon što prethodna dosegne terminalno stanje.

**Acceptance:** Završi plaćanje → nova prodaja generira novi `sid`; status novog
je `pending` dok stvarno ne stigne uplata.

---

## FL-02 [BUG] HUB3 opis plaćanja (66 znakova) prekoračuje FINA limit 35

**file:** `lib/ui/home_page.dart:119`

**Failure scenarij:** Polje "opis plaćanja" u HUB3 generira do 66 znakova; FINA
2D barkod spec ograničava to polje na 35. Banka može odbiti barkod ili odrezati
`sid` → tracking mrtav ili plaćanje odbijeno. Ovo NIJE promjena layouta (14
polja ostaju) — to je duljina sadržaja polja.

**Fix:** Ograničiti/validirati duljinu polja na 35 (i ostala polja na svoje FINA
maksimume); ako `sid` mora stati, koristiti kraću reprezentaciju.

**Acceptance:** Test: opis > 35 znakova → odrezan/odbijen prije generiranja
barkoda; generirani HUB3 poštuje sve FINA duljine.

---

## FL-03 [BUG] `tokenBalance` pretvara error-response u 0

**file:** `lib/services/blockscout_service.dart:61`

**Failure scenarij:** Na error/ne-200 odgovor Blockscouta, `tokenBalance` vrati
0 umjesto da signalizira grešku → header prikaže "Trenutno stanje €0,00" umjesto
"greška pri dohvatu". Trgovac misli da je stanje nula.

**Fix:** Baciti/propagirati grešku; UI prikaže "—"/retry, ne "0,00".

**Acceptance:** Mock 500 → UI stanje "greška", ne "€0,00".

---

## FL-04 [BUG] Iznos bez validacije: locale zarez → 0, negativan → deformiran HUB3

**file:** `lib/ui/home_page.dart:148`

**Failure scenarij:** Unos "1.234,56" (hr locale) parsira se u 0; negativan iznos
proizvodi deformiran HUB3 zapis (npr. `00000000000-500`). QR se ispeče s krivim/
nula iznosom.

**Fix:** Robustan parser (hr locale zarez→decimalna točka, tisućice), odbiti ≤0
prije generiranja QR-a. Vidi memory: iOS decimal input needs type=text — ista
klasa problema.

**Acceptance:** Test matrica: "1.234,56", "-5", "0", "" → definiran ispravan
iznos ili odbijeno; nikad deformiran HUB3.

---

## FL-05 [BUG] `EipPayload._units` RangeError za `tokenDecimals < 2`

**file:** `lib/models/eip681_payload.dart:42`

**Failure scenarij:** `_units` baca `RangeError` kad je `tokenDecimals < 2`;
budući da je to korisnički-editabilno polje, ruši build QR preview-a (crash umjesto
poruke).

**Fix:** Guard na `tokenDecimals` (min 0, validacija), graceful poruka.

**Acceptance:** `tokenDecimals=0/1` → QR se generira ili jasna validacijska
poruka, ne crash.

---

## FL-06 [BUG] `sid` nije validiran protiv backend `SID_RE` prije QR-a

**file:** `lib/ui/home_page.dart:104`

**Failure scenarij:** `sid` polje se ne validira protiv istog uzorka koji backend
očekuje (`SID_RE`) prije pečenja u QR. Nevaljan `sid` → QR skeniran i plaćen, ali
backend ga ne parsira (BW-09 klasa) → intent match nikad, tracking trajno mrtav.

**Fix:** Dijeliti `SID_RE` (isti regex kao backend `parseSidFromText` prihvatne
forme) i validirati prije generiranja.

**Acceptance:** Nevaljan `sid` → QR se ne generira dok se ne ispravi.

---

## FL-07 [RISK] Poll greške nakon prvog snapshota se tiho gutaju

**file:** `lib/ui/payment_status_page.dart:114`

**Failure scenarij:** Nakon prvog uspješnog snapshota, greške u pollu se tiho
gutaju → POS ekran izgleda "živ" (zadnje stanje) dok su mreža/backend mrtvi;
trgovac ne zna da status više nije aktualan.

**Fix:** Prikazati "veza izgubljena / zadnji put ažurirano prije X" nakon N
uzastopnih poll grešaka.

**Acceptance:** Ubij backend nakon prvog snapshota → UI pokaže stale/offline
indikator.

---

## FL-08 [RISK] Blockscout `tokentx` bez paginacije → netočni totali

**file:** `lib/services/blockscout_service.dart:20`

**Failure scenarij:** "Ukupno uplate/isplate" računa se iz jedne stranice
`tokentx` bez paginacije → kad povijest prijeđe page cap, totali tiho postaju
netočni (prikazuju manje nego stvarno).

**Fix:** Paginacija do kraja ili jasna oznaka "prikazano zadnjih N".

**Acceptance:** Račun s > page-cap transakcija → totali točni ili eksplicitno
ograničeni.

---

## FL-REFACTOR / FL-TEST-GAP

- **[REFACTOR]** `lib/ui/gnosis_history_page.dart:101` — duplicirana BigInt→double
  konverzija, stat-block widgeti, nekonzistentni block exploreri (gnosisscan vs
  blockscout). Konsolidirati.
- **[TEST-GAP]** `test/` pokriva samo `eip55_test.dart` + `widget_test.dart`.
  Nula testova za `intent_service`, payment-status polling, POS state machine,
  Blockscout parsing, EPC/HUB3 generiranje (amount/duljine polja). Vidi
  refactor-plan F3.
