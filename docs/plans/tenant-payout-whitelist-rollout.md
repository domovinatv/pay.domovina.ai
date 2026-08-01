# Rollout runbook — tenant payout whitelist (ADR 0016)

> Stanje na 2026-08-01: kod je commitan i pushan na granu
> `feat/tenant-payout-whitelist` (`3ace591`). **Nije merge-an u `main`, nije
> deployan, migracije nisu primijenjene na produkcijski D1** — provjereno:
> tablica `tenants` u produkciji ne postoji. `mpt.domovina.ai` vrti stari kod.
>
> Ovaj dokument je ono što bi inače ostalo samo u chatu: forenzika stvarnog
> stanja prije promjene, redoslijed deploya, kako provjeriti da je prošlo,
> kako se vratiti, i što je ostalo otvoreno.
>
> Zašto = `docs/decisions/0016-tenant-payout-whitelist.md`. Ovdje je samo kako.

## 1. Forenzika produkcije prije promjene (metoda, ne samo rezultat)

Seed migracija `0014` **nije izmišljen popis** — snimka je produkcijskog D1-a.
Ovo su upiti kojima je snimljena, da se rezultat može reproducirati ili
osvježiti prije samog deploya (u međuvremenu su mogli nastati novi walleti):

```bash
cd backend

# 1. Sve adrese ikad u opticaju (unija 4 izvora)
npx wrangler d1 execute pay_domovina --remote --json --command "
  SELECT lower(target_address) a, 'intent' src FROM payment_intents GROUP BY 1
  UNION SELECT lower(target_address), 'forward' FROM monerium_forwards GROUP BY 1
  UNION SELECT lower(safe_address), 'wallet_registry' FROM wallet_registry GROUP BY 1
  UNION SELECT lower(safe_address), 'wallet_account' FROM wallet_accounts GROUP BY 1"

# 2. Ima li plaćanja u letu koje bi prijelaz osirotio?
npx wrangler d1 execute pay_domovina --remote --json --command "
  SELECT sid, lower(target_address), expires_at FROM payment_intents WHERE state='pending'"

# 3. Koji oblici referenci stvarno postoje (provjera da parser ne lomi promet)
npx wrangler d1 execute pay_domovina --remote --json --command "
  SELECT memo, reference_number, state FROM monerium_orders ORDER BY updated_at DESC"
```

Rezultat 2026-08-01:

| Mjera | Vrijednost |
|---|---|
| Monerium ordera / forwarda / intenata | 43 / 41 / 70 |
| Distinct adresa (unija 4 izvora) | **52** → seeda se 51 (MPT Safe se izostavlja) |
| `wallet_registry` / `wallet_accounts` | 44 zapisa (40 distinct Safeova) / 7 |
| **Pending intenata** | **0** ← nijedno plaćanje u letu |
| Oblici referenci | **100 % `mpt:` + `sid`** — 0 × `cmp:`, 0 × goli `0x`, 0 × `gnosis:` |
| Najveći ikad prošao iznos | 1,21 € |

Zadnja dva reda su razlog zašto je postrožavanje sigurno: nijedan tok koji je
ikad prošao railom ne koristi oblik koji je ukinut.

⚠️ **Prije deploya ponovi upit 1 i 2.** Ako je u međuvremenu nastao novi
wallet, pokriva ga dinamički izvor `wallet_registry` (ne treba ništa raditi).
Ako je nastao pending intent na adresu izvan whiteliste — dodaj adresu ručno
prije deploya, inače će ta uplata biti parkirana.

## 2. Deploy — redoslijed je obavezan

```bash
cd backend

# 1) migracije PRVO
npm run db:migrate:prod        # 0013 shema + 0014 seed

# 2) provjeri seed prije nego Worker krene koristiti tablice
npx wrangler d1 execute pay_domovina --remote --command "
  SELECT (SELECT COUNT(*) FROM tenants) t,
         (SELECT COUNT(*) FROM tenant_payout_addresses) addrs,
         (SELECT COUNT(*) FROM payment_intents WHERE tenant_id IS NULL) orphans"
# očekivano: t=1, addrs=51, orphans=0

# 3) tek onda Worker
npm run deploy
```

Obrnutim redoslijedom `createIntent` piše u `tenant_id` stupac koji još ne
postoji → **svaki `POST /api/intents` puca**. Migracija je aditivna
(`CREATE TABLE` + `ALTER TABLE ADD COLUMN`), pa je stari Worker s novom shemom
bezopasan — zato migracija ide prva.

Opcionalno prije deploya (alerti inače degradiraju u `console.warn`):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

## 3. Provjera nakon deploya

```bash
# a) legitiman tok i dalje radi — adresa iz seeda
curl -s -X POST https://mpt.domovina.ai/api/intents \
  -H 'content-type: application/json' \
  -d '{"target_address":"0x6693a7d19486dc45e9f90fd2d515d972bba2d65e","amount_eur":"1.00"}' \
  | python3 -m json.tool | head -20
# očekivano: 200 + sid + memo "mpt:0x6693…?sid=…"

# b) nepoznata adresa se odbija
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mpt.domovina.ai/api/intents \
  -H 'content-type: application/json' \
  -d '{"target_address":"0x000000000000000000000000000000000000dead","amount_eur":"1.00"}'
# očekivano: 403

# c) admin provjera adrese
curl -s -u "$ADMIN_USER:$ADMIN_PASS" \
  https://mpt.domovina.ai/admin/api/tenants/domovina/check/0x6693a7d19486dc45e9f90fd2d515d972bba2d65e
# očekivano: {"allowed":true,"source":"static"}
```

Korak (a) je jedini koji stvarno dokazuje da rail nije zaključan — bez njega
deploy nije verificiran.

Zatim: `/admin/whitelist` (Basic Auth) mora listati 51 adresu, a
`/admin/forwards` dobiva novi filter `blocked`.

**Prvi stvarni end-to-end test:** pošalji 1 € SEPA s referencom iz koraka (a) i
prati `/admin/forwards` — očekivano `pending → submitted → confirmed`, kao i
prije. Tek to je dokaz da forward gate propušta legitiman promet.

## 4. Rollback

Kod: `npm run deploy` s prethodnog commita (`017c99e`). Shema se **ne vraća** —
migracije su aditivne, stari kod ignorira `tenant_id` i tenant tablice, pa je
rollback koda dovoljan i siguran.

Ako je problem uži od "sve je krivo":

| Simptom | Zahvat |
|---|---|
| Legitimna adresa blokirana | dodaj je na `/admin/whitelist` — djeluje odmah, bez deploya |
| Cijela klasa adresa blokirana | provjeri je li tenant `domovina` još `active` i ima li `allow_sources = ["wallet_registry"]` |
| Klijent dobiva 401 | `INTENT_REQUIRE_TENANT_KEY` je slučajno `1` — vrati na `0` i redeployaj |

## 5. Odluke donesene u ovom krugu (i zašto ne drukčije)

Tri odluke koje su oblikovale implementaciju, s odbačenim alternativama —
detaljnije u ADR-u §Alternative:

1. **Izvor whiteliste = sid-binding + statična lista + `wallet_registry`.**
   Čisto statična lista blokirala bi svakog novog korisnika Walleta (40+
   Safeova, raste self-serve). Binding bez whiteliste bio bi slabiji: tko zna
   bilo koju whitelistanu adresu mogao bi na nju usmjeriti tuđu uplatu.
2. **Meki uvod API ključa.** Oba postojeća klijenta su javna (browser bundle +
   Flutter app), pa ključ identificira tenanta, ne autentificira ga. Tvrdi
   ključ odmah lomi tri repozitorija za isti sigurnosni učinak.
3. **Telegram alerting, env-gated.** U kodu nije postojao — spominjao se samo u
   `safe-tx/*.md` kao ideja. Bez secreta degradira u `console.warn`; nikad ne
   puca na money putu.

## 6. Otvoreno nakon ovog deploya

| # | Stavka | Blokira |
|---|---|---|
| 1 | Merge grane u `main` (PR nije otvoren) | — |
| 2 | `INTENT_REQUIRE_TENANT_KEY=1` traži `pk_` ključ u Flutter appu, wallet PWA i e-demokracija repou | koordinirani deploy 3 repozitorija |
| 3 | `safe-tx/006` — Zodiac Roles scoping, pripremljen ali **neizvršen**; enum vrijednosti Roles v2 nisu pročitane s deployanog ugovora | verifikacija + simulacija na forku prije 2/3 potpisa |
| 4 | **MultiSend zaobilazi on-chain scoping** — uključivanje `PAYMENT_REGISTRY_ADDRESS` bez `setTransactionUnwrapper` poništava batch 006 | preduvjet za PaymentRegistry |
| 5 | Telegram secreti nisu provisionirani | alerti trenutno idu samo u CF Observability |
| 6 | `cmp:` rail nikad nije prošao produkcijom (0 ordera); prva kampanja mora biti registrirana kroz `/admin/whitelist` prije objave QR-a | — |

### Interakcija s otvorenim Fable5 nalazima

Ovaj rad **ne rješava** nalaze iz `docs/reviews/2026-07-fable5/`, ali dodiruje
dva pa je redoslijed bitan:

- **BW-09** (skraćivanje 64-hex u 40-hex adresu) — **zatvoren** ovdje, granicom
  na `ADDR_RE` + testom.
- **BW-02** (dvostruki forward / nonce-race) — `maybeForward` je i dalje
  check-then-act bez atomskog zasuna. Whitelista ne mijenja tu utrku, samo
  sužava skup adresa na koje se može dogoditi. Fix ide zasebno.
- **BW-01** (underpayment → `paid`) — netaknut; whitelista provjerava *kamo*, ne
  *koliko*.
- Refactor koji je ovaj rad napravio (`handleForward` → `src/monerium/forward.ts`
  s injektiranim ovisnostima) **olakšava** oba gornja fixa — sad postoji mjesto
  s testovima u koje se atomski zasun i usporedba iznosa mogu ugurati.

## 7. Sitnice koje se lako zaborave

- **Admin forma za novi intent ide kroz javni `/api/intents`**, pa i ona dobiva
  403 za adresu izvan whiteliste. Poruka u formi upućuje na karticu Whitelist.
- **Opoziv adrese djeluje na već izdane intente** — `authorizeForward` provjerava
  whitelistu u trenutku *forwarda*, ne u trenutku kreiranja intenta. To je
  namjerno (opoziv mora biti trenutan), ali znači da opoziv može parkirati
  uplatu koja je već u SEPA tranzitu.
- **MPT Safe nije na whitelisti i ne smije biti.** Memo prema Safeu je
  `self_noop` grana — vrijednost ne izlazi, pa payout dozvola nema smisla.
  Binding se ipak traži, inače bi nevezani memo mogao flipati tuđi intent u
  `paid`.
- **`status='blocked'` vs `'failed'`** — `blocked` znači "naša politika je
  odbila", `failed` znači "lanac/RPC je odbio". Razlog stoji u
  `error = not_whitelisted:<reason>`. Jedina iznimka: `no_routing_target` je
  zadržao stari `failed` status da postojeći admin filteri i dalje rade.
- **Testovi ne diraju D1 ni RPC.** `authorizeForward` i `handleForward` primaju
  ovisnosti; `isAddressWhitelisted` se testira protiv lažnog D1-a koji matcha po
  SQL substringu. Ako mijenjaš SQL u `tenants/db.ts`, lažni D1 u
  `test/whitelist.test.ts` baca `unexpected SQL` umjesto da tiho prođe.
