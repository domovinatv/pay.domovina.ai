# Detektor krađe (ADR 0019 faza 0), `resolved_offrail`, admin prijava — nalazi (Fable 5.1, 2026-10-09)

Opseg: `backend/src/monerium/outflowWatch.ts`, `monerium/offrail.ts`,
`admin/auth/*`, `admin/app.ts`, `tenants/admin.ts`, `tenants/railAdmin.ts` na
HEAD `ef6622c`. Oznake kao u `rail-multi-tenant-stray.md`.

---

## A. Detektor krađe (`outflowWatch.ts`)

### TD-01 [SEC] Klasifikacija po `tx.to === rolesModifier` — krađa kroz pomoćni ugovor dobiva ℹ️ „ručni 2/3 transfer" umjesto 🚨

**Gdje.** `monerium/outflowWatch.ts:103-114` `classify`: `txTarget(txHash)`
(:186-189 → `tx.to`) uspoređuje s modifierom; sve ostalo je `'other'` →
`alertText` ℹ️ „Nije prošao kroz forwarder rolu (npr. ručni 2/3 transfer)".

**Kako puca.** Napadač s `ROUTER_PRIVATE_KEY` ne zove modifier izravno nego
deploya 30-linijski ugovor `Relay { function go(){ roles.execTransactionWithRole(...) } }`
ili koristi bilo koji javni multicall. `tx.to` = Relay ≠ modifier → ℹ️.
Operater vidi „ručni transfer vlasnika", pretpostavi kolegu, ne opoziva rolu.
Napad traje do sljedeće ručne provjere. Detektor je upravo za taj scenarij
(ADR 0019 §Problem) i tu pada.

**Popravak.** Klasificirati po **logovima receipta**, ne po `tx.to`:
- Safe emitira `ExecutionFromModuleSuccess(address indexed module)` /
  `ExecutionFromModuleFailure` za svaku modul-transakciju i `ExecutionSuccess(bytes32
  txHash, uint256 payment)` za vlasničke. Roles v2 dodatno emitira vlastite
  evente.
- `classify`: receipt sadrži `ExecutionFromModuleSuccess(module = rolesModifier)`
  iz `safe` → put kroz rolu → `role_unknown`/`role_unhashed`; sadrži
  `ExecutionSuccess` iz `safe` → vlasnici → `other`; ni jedno (npr. transfer iz
  Safe-a preko drugog modula) → novi verdikt `module_unknown` 🚨.
- `txTarget` postaje `txSafeEvents(txHash)` (jedan `getTransactionReceipt`;
  već se radi za `safeOutflows` u offrail.ts).

**Test** (`outflowWatch.test.ts`): receipt s `ExecutionFromModuleSuccess(rolesModifier)`
i `tx.to = 0xRelay` → 🚨; receipt s `ExecutionSuccess` → ℹ️; receipt s
`ExecutionFromModuleSuccess(0xOtherModule)` → 🚨 `module_unknown`.

---

### TD-02 [RISK] Detektor živi u Workeru kojem po modelu prijetnje ne vjerujemo; nema vanjskog dead-man signala

**Gdje.** `index.ts:486-491` — cron u istom Workeru; `outflowWatch.ts:23-24`
„fail-open: RPC error skips this tick". Nema zapisa „tick se dogodio" osim
`console.warn` kad ima nalaza.

**Kako puca.** Tko može deployati Worker (ADR 0019: to je napadač), deploya
verziju bez cron-a ili s `return 0` u `watchAllRailOutflows`, pa krade. Isto
ako RPC trajno odbija `getLogs` (TD-04): detektor godinama „radi", a ništa ne
vidi. Operater ne razlikuje „nema krađe" od „detektor ne radi".

**Popravak.**
1. **Heartbeat izvan CF računa:** na kraju svakog uspješnog ticka `fetch` na
   dead-man URL (healthchecks.io / Better Stack / vlastiti), koji alarmira ako
   ping ne stigne 10 min. Tajna URL-a u secretu; nije ovisna o Telegramu.
2. **Audit red** `outflow.tick` svakih N tickova (npr. svaki 30. = 1 h) s
   `from/to/outflows`, da se iz baze vidi zadnji pregled.
3. **Neovisni promatrač** (srednji rok): ADR 0019 Android mesh ili drugi CF
   račun / Tenderly alert na `Transfer(from=MPT Safe)` → zasebni Telegram kanal.
   Jeftino: Tenderly Web3 Action ili Gnosisscan „address watch" e-mail na Safe.
4. Alert kad `head − cursor > 500` blokova (~40 min) → „detektor zaostaje".

---

### TD-03 [LOW] `role_unhashed` (⚠️) se može namjestiti preko trajnih `failed` redova bez tx hasha

**Gdje.** `outflowWatch.ts:196-202` `hasUnhashedForward(to, amountWei)` —
`tx_hash IS NULL AND target_address = ? AND amount_wei = ?`, bez uvjeta na
`status`/starost. `failed` red nakon neuspjelog broadcasta ima `tx_hash NULL`
i stvarni `amount_wei` zauvijek (`forward.ts:307-311`).

**Kako puca.** Napadač s ključem pogleda `/admin/forwards` (ne može) — ili
jednostavno pogodi: pošalje iznos i cilj jednak nekom starom `failed` forwardu
(cilj = whitelistirani Safe koji kontrolira, iznos iz prijašnjeg vlastitog
neuspjelog plaćanja). Alert ⚠️ „Worker je vjerojatno pao između broadcasta i
zapisa — upiši tx_hash ručno" umjesto 🚨. Niska vjerojatnost, trivijalan fix.

**Popravak.** `… AND status = 'pending' AND created_at > ? (now − 15 min)`.
Test: `failed` red star 1 dan → 🚨, `pending` red star 1 min → ⚠️.

---

### TD-04 [RISK] Raspon `getLogs` do 2000 blokova na javnom RPC-u; trajni neuspjeh = tihi stall

**Gdje.** `outflowWatch.ts:33, 79-81` — `MAX_RANGE = 2000n`; greška →
`watchAllRailOutflows` catch → `console.error`, kursor stoji (:97-99).

**Kako puca.** Nakon ispada > ~3 h kursor zaostaje > 2000 blokova; ako
`rpc.gnosischain.com` odbije raspon (javni RPC-ovi često 1000 ili 10 s
timeout), svaki tick pada identično → kursor nikad ne napreduje, nema alarma
(fail-open). Detektor slijep neodređeno dugo.

**Popravak.** Na grešku pokušati pola raspona (do 100 blokova), pa tek onda
odustati; nakon 3 uzastopna neuspjela ticka alarm ⚠️ „detektor ne može čitati
chain" (KV brojač). Uz XD-02 (RPC fallback, otvoreno) problem gotovo nestaje.

---

### TD-05 [LOW] Prvi tick za novi tenant Safe počinje od `head`, bez provjere povijesti

**Gdje.** `outflowWatch.ts:73-76`. Za novi tenant Safe to je ispravno
(nema naše povijesti), ali verify (`onboarding.ts:386-458`) ne provjerava ima
li Safe **druge module** osim Roles modifiera (`getModulesPaginated`). Modul
koji je tenant (ili netko prije) uključio može slati EURe mimo role; detektor to
vidi kao ℹ️ (TD-01 fix → 🚨). Dodati verify check `only_module_is_roles`.

---

## B. `resolved_offrail` (`offrail.ts`)

### OF-01 [LOW] Odabir „koji transfer u batchu zatvara order" je heuristika; evidentirani `to`/`value` mogu biti kriva noga

**Gdje.** `monerium/offrail.ts:75-80` — memo cilj ako postoji, inače
**najveći** transfer u tx-u; zapis `to/value_wei` u red i audit.

**Kako puca.** Operater jednim 2/3 batchom vrati tri parkirane uplate (3
transfera). Za order A (bez memo cilja) `pick` = najveći transfer (koji pripada
orderu C) → red A pokazuje C-ov cilj i iznos. `tx_already_used` zatim **odbija**
ordere B i C („jedan tx zatvara jedan order", :68-70) → B i C ostaju parkirani
i dalje nude „Preusmjeri…" (dupla isplata moguća, upravo ono što offrail
sprječava).

**Popravak.** Dopustiti isti tx za više ordera ako se **različite noge**
koriste: operater bira nogu (`to` + `value`) iz popisa koji server vrati
(`GET /admin/api/orders/:id/offrail-legs?tx=`), a `forwardIdsByTx` provjera
postaje „ta noga (tx, logIndex) još nije iskorištena" (spremiti `log_index` u
`error` ili novi stupac). Alternativa minimum: dopustiti `tx_already_used`
override kad `value_wei` noge == iznos ordera i noga nije iskorištena.

**Test.** tx s 3 noge → 3 ordera zatvorena, 4. odbijen; ista noga dvaput → odbijena.

---

### OF-02 [LOW] Provjera „EURe izlaz iz Safe-a" ne provjerava **iznos** prema orderu

**Gdje.** `offrail.ts:72-90` — prihvaća bilo koji iznos. Operater može
„zatvoriti" order od 500 € tx-om od 1 €; order više nije moguće preusmjeriti, a
499 € ostaje u Safe-u bez traga. Zahtijevati `pick.valueWei === eurToWei(order.amount)`
ili `force` + razlog u auditu (isti obrazac kao SR-02).

---

## C. Admin prijava i admin API

### AD-01 [BUG → audit] Nakon ukidanja Basic Autha svaki audit zapis tenant/rail admina ima `actor = 'admin:unknown'`

**Gdje.** `tenants/admin.ts:38-46` `actorFrom(header)` dekodira **Basic**
zaglavlje; pozivi u `tenants/admin.ts:83, 100, 146, 170, 214, 232, 245` i
`tenants/railAdmin.ts:55, 85, 115, 131, 152, 170`. Sesija postoji
(`admin/auth/mount.ts:114` `c.set('adminSession', …)`), a koristi je samo
`admin/app.ts:109` (offrail). `docs/admin-auth.md:39` kaže „Basic Auth
zaglavlje više ništa ne otvara" — točno, pa `Authorization` nikad nije `Basic`.

**Kako puca.** `tenant_audit_log` za `address.add`, `key.issue`,
`tenant.activate`, `rail.update`, `rail.router_rotate`… više ne zna **tko**.
Upravo radnje koje mijenjaju kamo novac smije ići gube atribuciju. Dva admina
(`ADMIN_EMAILS` ima dva) → forenzika nemoguća.

**Popravak.** `actorFrom(c)` → `adminSession(c)?.email ?? 'admin:unknown'`
(prebaciti u `admin/auth/mount.ts`, obrisati Basic dekoder). Test: audit red
nosi e-mail iz sesije.

---

### AD-02 [RISK] `ADMIN_TOKEN` statični bearer i dalje otvara Monerium admin rute (registracija webhooka, sync) i PII rute, mimo sesijskog modela i bez audita

**Gdje.** `index.ts:196-198` (`/api/monerium/orders*`), `:213-216`
(`/api/hpb/admin/*`), `:262-264` (`/api/monerium/admin/*`: `/sync`,
`/profiles`, `/webhooks` POST, `/replay-last`).

**Kako puca.** `POST /api/monerium/admin/webhooks {url: attacker}` registrira
Monerium pretplatu na napadačev URL **s našim `MONERIUM_WEBHOOK_SECRET`** → sve
ITalk ordere (IBAN, ime, iznos) prima treća strana, bez zapisa u auditu. Token
je dugoživući, u `wrangler secret`, dijeli se kroz curl-skripte. Ne smanjuje
sigurnost odmah (token = pun pristup i prije), ali admin model je sad dvojan:
passkey+Access za UI, statični token za najosjetljivije operacije.

**Popravak.** (1) Premjestiti `/api/monerium/admin/*` i `/api/hpb/admin/*` pod
`/admin/api/…` (sesija + CSRF + audit); (2) ako curl pristup treba, uvesti
kratkoživuće tokene iz admin UI-a (`POST /admin/api/tokens` → 1 h, hash u D1,
audit); (3) `ADMIN_TOKEN` rotirati nakon premještanja i ostaviti samo za
`/api/monerium/orders*` dok ga Flutter/alat ne prestane koristiti (provjeriti
grep — po ADR 0017 nitko ga ne zove → obrisati rutu).

---

### AD-03 [LOW] Passkey registracija nema potvrdu identiteta (re-auth) i nema gornje granice broja ključeva

**Gdje.** `admin/auth/mount.ts:157-168` — svaka valjana sesija (i ona iz
Accessa od prije 11 h) može dodati novi passkey. Ukradena sesija (XSS je
blokiran CSP-om, ali kolačić na kompromitiranom računalu) → trajni pristup i
nakon isteka sesije, dok ga nitko ne primijeti u `/admin/passkeys`.

**Popravak.** Registracija passkeya traži sesiju mlađu od 10 min **ili** svježu
WebAuthn/Access potvrdu (`method === 'access'` ili `created_at > now − 10 min`);
Telegram alert „dodan admin passkey (e-mail, label, UA)"; max 5 ključeva po
e-mailu.

---

### AD-04 [LOW] Sesija bez idle-timeouta i bez rotacije; `admin_sessions` čisti se samo pri loginu

**Gdje.** `admin/auth/session.ts:10, 40-57` — 12 h apsolutno, `DELETE expired`
samo u `createSession`. Prihvatljivo; predlažem idle 2 h (`last_seen_at` update
jednom u 5 min) i brisanje istekih u 6-satnom cronu. Nije sigurnosna rupa.

---

### AD-05 [LOW] Ručni reroute i offrail nemaju „4-eyes" za iznose iznad praga

**Gdje.** `admin/app.ts:90-112`. Jedan admin, dva klika, bilo koji iznos.
Uz SR-02 (iznos) i OF-02 predlažem: iznad `ADMIN_FOUR_EYES_CENTS` (npr. 1000 €)
akcija stvara `pending_approval` red koji **drugi** e-mail iz `ADMIN_EMAILS`
potvrđuje. Nije hitno dok su iznosi 1 €, ali u dizajn ulazi sada (ADR 0019
kvorum rješava isto za potpis, ne za operatersku odluku).

---

## D. Što je dobro (da se ne pokvari)

- Potpis webhooka samo tajnom tenanta iz URL-a, nikad „bilo koja koja prolazi"
  (`webhookHandler.ts:22-25, 105`); testovi za tuđu tajnu i ITalkovu tajnu na
  tenant URL-u postoje.
- AAD `<tenant>|<field>` na tajnama (`secrets.ts:67-69`): presađivanje
  šifrata među redovima ne prolazi.
- Latch 0016 + 0018 (`insertForward` ON CONFLICT DO NOTHING, `claimForward`
  petlja) — ispravna semantika „INSERT je odluka"; `park` **ne** uzima latch
  pa retry nakon `failed` radi.
- `park` uvijek prijavljuje memo, ne pogodak (`forward.ts:172-174, 227-230`).
- `authorizeForward` jedina točka odluke; reroute i resolver prolaze kroz nju.
- Offrail provjera on-chain (status + EURe `Transfer` iz Safe-a), jedan tx =
  jedan order (uz OF-01 nijansu).
- Admin: `__Host-` kolačić, sha-256 tokena u bazi, Origin CSRF, CSP s nonceom,
  `safeNext`, Access JWT s `aud`+`iss`+RS256, `ADMIN_EMAILS` provjera po zahtjevu.
- Detektor: kursor se pomiče tek nakon što svi alarmi odu (:97-99).
