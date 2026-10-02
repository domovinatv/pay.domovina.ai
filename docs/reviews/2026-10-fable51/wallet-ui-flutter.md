# Wallet PWA (rute/UI/SDK) + Flutter app — nalazi (Fable 5.1, 2026-10-02)

Opseg: `wallet/src/routes/**`, `wallet/src/components/**`, `wallet/src/state/**`,
`wallet/src/lib/{gnosispay,registry,activity,paymentReceipt,recipients,turnstile,errors}.ts`,
`wallet/public/sdk.js`, `wallet/public/_headers`, te `lib/**` (Flutter).
Crypto jezgra walleta i relayer su u `wallet-crypto-relayer.md`.

Wallet kod se **nije mijenjao** od srpanjskog reviewa (`git diff 017c99e..HEAD -- wallet`
je prazan), pa su svi WP-* nalazi iz srpnja i dalje otvoreni — ovdje su potvrđeni
protiv koda i dopunjeni novima. U Flutteru su se mijenjala samo dva fajla
(`c3ff2a1`, POS zelen na `received`), što je donijelo nove nalaze.

---

## A. Flutter (`lib/`)

### Stanje nalaza iz srpnja

| ID | Stanje | Dokaz |
|---|---|---|
| FL-01 sid se ne rotira nakon prodaje | **OTVORENO** | `lib/ui/home_page.dart:451-458` otvara `PaymentStatusPage(sid: _sidValue)`; ništa ne rotira `_sid` po povratku. Pogoršano: `lib/services/intent_service.dart:47` tretira 409 kao uspjeh, pa druga prodaja s istim sid-om **nastavlja stari intent** — zaglavlje pokazuje stari iznos (`payment_status_page.dart:195`), QR nosi novi. |
| FL-02 HUB3 opis 66 znakova > FINA 35 | **OTVORENO** | `home_page.dart:116-118` gradi `gnosis:<addr>?sid=<sid>` = 66 znakova; `lib/models/hub3_payload.dart:67` emitira bez skraćivanja. |
| FL-03 `tokenBalance` greška → 0 | **DJELOMIČNO** | `lib/services/blockscout_service.dart:56-61`: ne-200 sad baca, ali 200 sa `status:"0"` i dalje daje `BigInt.zero`, koji `gnosis_history_page.dart:331,381` prikazuje kao stvarno stanje. |
| FL-04 hr-zarez / negativan iznos | **OTVORENO** | `home_page.dart:143-144` `double.tryParse(text.replaceAll(',', '.')) ?? 0`. `"1.234,56"` → null → 0 → EPC **bez iznosa**, HUB3 s `000000000000000`. `"-5"` → HUB3 dobije `00000000000-500` (`:158`). |
| FL-05 `_units` RangeError za decimals < 2 | **OTVORENO** | `lib/models/eip681_payload.dart:42` `pow(decimals - 2)`; polje je korisnički uredivo (`home_page.dart:98`). |
| FL-06 sid nije validiran protiv `SID_RE` | **OTVORENO** | Nema `RegExp` u `home_page.dart`; sid `"abc d"` → QR ispečen, `createIntent` 400, poll 404 → re-register → 400 → vječna petlja (`payment_status_page.dart:100-112`). |
| FL-07 greške polla nakon prvog snapshota progutane | **OTVORENO** | `payment_status_page.dart:113-115`. |
| FL-08 `tokentx` bez paginacije | **OTVORENO** | `blockscout_service.dart:20-26`. |
| FL-REFACTOR / TEST-GAP | **OTVORENO** | `test/payment_status_test.dart` ima 3 testa na copy/`isReceived`; nula testova za `fromWire`, polling, POS, parsere, EPC/HUB3 sadržaj. |

### Novi nalazi

**FL-N-01 [MONEY-BUG] Kasni odgovor polla nakon terminalne faze može POS trajno ostaviti na zelenom**
`lib/ui/payment_status_page.dart:83,86-99`. `Timer.periodic(2 s)` bez in-flight zaštite; svaki `_poll` je neovisan `await`. Na terminalnoj fazi timer se gasi (`:97-98`), ali **raniji, sporiji** zahtjev još leti i po dolasku bezuvjetno radi `setState(_snapshot = snap)` (`:90-91`).
Scenarij: poll A (spor) → poll B vrati `rejected` (crveno, timer ugašen) → A stigne s `received_processing` → kiosk postane zelen „Uplata zaprimljena ✓" i više se nikad ne osvježi. Isto `settled` → zaglavi na „prosljeđivanje".
Popravak: monotoni redni broj zahtjeva (`final seq = ++_pollSeq; … if (seq < _lastAppliedSeq) return;`) ili preskakanje ticka dok zahtjev leti; nakon primijenjenog terminalnog snapshota odbaciti svaki kasniji ne-terminalni.

**FL-N-02 [RISK] POS „zeleno na received" pali se i tijekom Monerium screeninga koji može završiti odbijanjem**
`lib/models/payment_status.dart:30-33` `isReceived` uključuje `receivedProcessing`; `payment_status_page.dart:437-444` crta puni zeleni ekran s kvačicom. Backend vraća `received_processing` za `placed|pending` ordere (`backend/src/intents/stage.ts:187`) i `rejected` ako Monerium odbije (`:165`). Backend čak javlja `reviewExpected == true` (prva uplata s IBAN-a, ručni pregled 1 min–8 h; `payment_status.dart:93`), a POS to ignorira. Reverzija se prikaže (poll ide do `rejected`), ali kiosk je zelen upravo u prozoru kad trgovac predaje robu, a satima kasnije nitko ne gleda. `settled` i `received` dijele identičan vizual; razlikuje ih samo naslov.
Popravak: u `_buildPosView` zeleno tražiti `minted/forwarding/settled` ILI (`receivedProcessing && reviewExpected == false`); za `reviewExpected == true` žuto s „Zaprimljeno — provjera u tijeku, ne isporučuj još". Puno zeleno samo za `settled`, ili barem različita ikona.

**FL-N-03 [BUG] POS/timeline lažu kad je forward `failed`/`blocked`**
Backend mapira `failed|blocked` u fazu `minted` s korakom `failed` + `forward_error` (`stage.ts:180-184`). Dart `PaymentStatus.fromJson` (`payment_status.dart:109-125`) ne parsira `forward_error`; `stageNote` za `minted` kaže „EURe je izdan i prosljeđuje se primatelju…" (`:193-195`); POS pokazuje zeleno „Uplata zaprimljena ✓" (`:437`) i polla zauvijek. Trgovac novac **nije** dobio (parkiran u MPT Safe-u).
Popravak: parsirati `forward_error` i status koraka `forwarding`; kod failed/blocked POS naslov „Zaprimljeno — prosljeđivanje nije uspjelo" u žutom.

**FL-N-04 [RISK] Nepoznat string faze tiho postaje `awaiting_payment`**
`payment_status.dart:20-23` `orElse: () => PaymentStage.awaitingPayment`. Potvrđeno: ne ruši, nikad ne mapira u paid, Dart enum odgovara 7 backend faza (`stage.ts:24-31`). Ali buduća faza bi se renderirala kao „Čeka se uplata" sa satom, zauvijek.
Popravak: `unknown(wire)` varijanta → neutralan naslov „Status nepoznat — ažuriraj aplikaciju", poll nastavlja.

**FL-N-05 [TEST-GAP]** Nema testa za `fromWire` na nepoznat ulaz, `_poll` race, HUB3 negativan iznos, hr-zarez.

### Potvrđeno dobro (Flutter)
- `isTerminal` isključuje `expired`, pa order koji stigne nakon isteka ipak izroni (`payment_status.dart:25-26`).
- Iznos intenta i EPC iznos oba `toStringAsFixed(2)` → konzistentno.
- Zadani `_randomSid` (12 znakova, `[a-z2-9]`) zadovoljava `SID_RE`.
- 404 self-heal re-register je idempotentan.

---

## B. Wallet PWA — rute, UI, SDK

### Stanje nalaza iz srpnja

| ID | Stanje | Dokaz |
|---|---|---|
| WP-03 arhivirani derived račun uskrsne | **OTVORENO** | `wallet/src/lib/accounts.ts:244-253` samo `delete reg[key]`; `syncAccountsWithBackend` `:289-301` ponovno doda svaki remote red `if (!reg[key])`. Nema tombstonea. |
| WP-04 `setIdentity` zadrži stari balance | **OTVORENO** | `wallet/src/state/store.ts:44-54` bez `balance: null`; `setAccount` ga ima (`:67`). |
| WP-05 Receive šalje float iznos | **OTVORENO (nisko)** | `Receive.tsx:107-108` → `paymentIntent.ts:51` sirovi broj → backend `Math.round(amountEur*100)` tiho zaokruži. |
| WP-07 lažni timeout relaya → dvostruko slanje | **OTVORENO** | `Send.tsx:293-301` `sendInFlightRef` rješava samo double-tap u istoj sesiji. `relay.ts:47-59` je goli `fetch` bez timeouta/idempotency ključa; mrežna greška **nakon** broadcasta → UI „Slanje neuspješno" (`:383-387`) → korisnik ponovi → `getSafeTxHash` čita uvećani nonce → **drugi transfer**. |
| WP-08 `/recover` prefila sweep odredište iz URL-a | **OTVORENO** | `Recover.tsx:43` `useState(qp('to'))`. |
| WP-09 Embed bez threshold guarda | **OTVORENO** | `Embed.tsx` nikad ne zove `readSafeThreshold`; `Send.tsx:54-60,314-321` zove. |
| WP-10 SDK `connect()` pojede `createAccount()` povratak | **OTVORENO** | `sdk.js:117-145` `consumeReturnParams` prihvaća svaki `dw_return=1`, briše `dw_state` (single-use) bez provjere `dw_account`/`dw_error`. Ako host zove `connect()` prije `createAccount()` na povratku → redirect petlja. (NEPROVJERENO je li pinkin redoslijed poziva to okida.) |
| WP-11 GP „≤50 € bez 2. ownera" | **DJELOMIČNO** | `GpCardScreen.tsx:40-41,70,260`: cap je po tapu 50 €; komentar „max kumulativni" i dalje netočan — N tapova „50 €" je neograničeno. |
| WP-12 `formatEureShort` zaokružuje | **OTVORENO** | `balances.ts:48` `toFixed(2)`; komentar `:43` kaže truncate. |

### Novi nalazi

**WU-01 [SEC] `/embed` potvrdna kartica je clickjackable; iznos koji korisnik vidi nije ono što potpisuje**
`wallet/public/_headers:35-37` postavlja `Content-Security-Policy: frame-ancestors *` na `/embed`; potvrda iznosa/primatelja i gumb „Potpiši Face ID-om" žive **unutar** tog frameable dokumenta (`Embed.tsx:321-344`). Fullscreen stil iz SDK-a je savjetodavan — neprijateljski host ne treba `sdk.js`: može uokviriti `/embed` s `opacity:0` preko svog lažnog „Plati 1 EURe" gumba, poslati `{type:'send', to:NAPADAČ, amount:'1000', credentialId, safeAddress}` (oba su u hostovom localStorageu od ranijeg legitimnog `connect()`) i korisnikov klik sleti na pravi gumb. OS Face ID sheet pokazuje samo RP (`wallet.domovina.ai`), ne iznos. Origin provjere (`:156-159`) ne pomažu — napadač **jest** origin.
Popravak: potvrdu + potpis maknuti iz frameable konteksta: `window.open(WALLET_ORIGIN + '/confirm?req=…')` (top-level, ne može se prekriti) ili barem (a) odbiti naredbe dok `document.visibilityState !== 'visible'` + IntersectionObserver v2 `isVisible` gdje postoji, (b) arm-delay 500–1000 ms prije nego gumb prima klik, (c) `frame-ancestors 'none'` za sve ostale rute (komentar u `_headers:33` to odgađa; `/send?to=&amount=` prefill u `Send.tsx:137-170` razlog je da se zatvori sad, iako storage partitioning to ublažava — NEPROVJERENO po browseru).

**WU-02 [RISK] Druga `send` naredba zamijeni potvrdnu karticu na mjestu**
`Embed.tsx:70-85,196-205`: `handleCommand` se zove za svaku `send` poruku i `setStage({kind:'send-confirm'})` prepiše karticu koju korisnik gleda (nema `stage.kind !== 'waiting' → postError('busy')`). Host može zamijeniti `to`/`amount` 100 ms prije tapa.
Popravak: `postError('busy')` za svaku novu naredbu dok `stage.kind !== 'waiting'`; handler gumba vezati na `requestId` za koji je kartica renderirana.

**WU-03 [RISK] „Poslano ✓" je broadcast, ne potvrda**
Relay vraća hash izravno iz `wallet.sendTransaction` (`wallet/functions/api/relay.ts:240-241,277`, bez čekanja receipta). `Send.tsx:375-379` postavi `txHash`, zove `addRecipient(to)` i toasta „Poslano ✓"; `Embed.tsx:285-292` šalje `{txHash}` hostu. Revertan/dropped tx (nonce sudar iz WP-07, race na stanju) nikad se ne prikaže, balance se ne osvježi.
Popravak: nakon relay ok, `publicClient.waitForTransactionReceipt({hash})` u pozadini → kartica „Potvrđeno" / „Neuspjelo (revert)" + refetch balancea; `addRecipient` tek na uspjeh.

**WU-04 [RISK] GP JWT istek se ne provjerava klijentski**
`gnosispay.ts:62-69` `decodeGpJwt` ignorira `exp`; `gpStore.ts:34-37,80-89` izvodi korak iz možda isteklog tokena do prvog 401. Sigurnosno bezopasno (samo memorija, nikad u storage, nikad u Embed). Popravak: `if (payload.exp*1000 < Date.now()) return null`.

**WU-05 [RISK] `VITE_GP_SIWE_DOMAIN` override potpisuje SIWE za domenu ≠ origin**
`gnosispay.ts:131-132`. Staging workaround (TODO-MATIJA #1); ako procuri u prod build, korisnik potpisuje login za domenu na kojoj nije. Popravak: `if (override && import.meta.env.PROD) throw`.

**WU-06 [RISK-nisko] `/ui-preview` dev ruta ide u prod**
`wallet/src/App.tsx:25` bez gatea (za razliku od `/kartica`, `:50`). Gate na `import.meta.env.DEV`.

**WU-07 [TEST-GAP]** Nema testova za `Embed.tsx` obradu poruka, `sdk.js` return-param konzumaciju (WP-10), ni Send retry put.

### Potvrđeno dobro (wallet UI)
- Embed origin: koristi `event.origin`, odbija lažni `cmd.parentOrigin` (`:156-159`), zaključa na prvi origin (`:78-82`), `targetOrigin` na rezultatima (`:96,99`); READY/SHOW/HIDE prema `*` ne nose podatke. Balance se nikad ne izlaže; Safe adresa je samo ono što je host već saznao kroz `connect()`.
- Embed ne može potpisati iz tuđeg walleta: `resolveSendAccount` (`:212-244`) traži da hostov `safeAddress` bude bootstrap ili derived račun pod istim `credentialId`.
- `sdk.js`: `event.origin === WALLET_ORIGIN` (`:66`), single-use CSRF `dw_state` (`:129-139`); Landing return allowlist regex je sidren (`Landing.tsx:106-118`).
- Send: `sendInFlightRef` + `disabled={!valid || busy}`; Max koristi točan `formatUnits` string; bigint usporedba s balanceom; self-send guard; threshold re-check u zadnji čas (`:314-321`); `parseAmount` prihvaća zarez, odbija > 18 decimala; `isAddress` strict (checksum na mixed case). Skenirani QR odbija ne-Gnosis chain / ne-EURe (`eip681.ts:76-90`).
- Jedini `message` listener u `wallet/src` je Embed; ExpandAccess koristi redirecte.
- Landing: jedno mjesto `createPasskey` (`:440`), samo kroz `runCreate`; empty-registry picker probe + `excludeCredentials` (`:382-414`); put bez excludea je eksplicitan korisnički izbor; nema Signal API-ja (samo zakomentiran u `passkey.ts:655-676`).
- `recipients.ts` validira svaki red pri čitanju.

### Neprovjereno
- React 18 discrete-event flush kao zaštita od double-clicka u Embedu (zaključeno, ne izvršeno).
- Zove li pinka `connect()` prije `createAccount()` na povratku (odlučuje je li WP-10 živa petlja).
- Neutralizira li storage partitioning u potpunosti uokvireni `/send?to=&amount=` na aktualnim Safari/Chrome/Firefox.
