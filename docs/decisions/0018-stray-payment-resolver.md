# ADR 0018 — Uplate bez reference: povezivanje s intentom po tenantu, iznosu i vremenu

- **Status:** Accepted (2026-10-08, grana `feat/stray-resolver`)
- **Kontekst:** `backend/` (Cloudflare Worker, MPT rail)
- **Gradi na:** [0016](0016-tenant-payout-whitelist.md) (forward je fail-closed,
  binding + whitelist) · [0017](0017-multi-tenant-rail.md) (tenant = rail)
- **Kod:** `backend/src/monerium/strayResolver.ts`, `forward.ts` (`handleForward`,
  `rerouteParkedOrder`), `intents/db.ts` (`findStrayCandidates`,
  `listRerouteCandidates`), migracija `0018_stray_resolver.sql`, admin
  `/admin/forwards` → „Preusmjeri…“

## Problem

Od 7. 10. 2026. Revolut iOS ispušta remittance iz EPC QR-a kad stanje računa
pokriva iznos (memory `feedback_epc_format`, ~45 varijanti formata provjereno bez
učinka). Isto se događa i kad platitelj ručno obriše ili prepiše referencu.
Takva uplata stigne s praznim memom, a ADR 0016 je parkira kao
`no_routing_target`. EURe ostaje u MPT Safe-u dok operater ručno ne napravi
transfer.

Produkcija 7. 10. (tenant `italk`, isti platitelj):

| forward | uplata | iznos | intenti tenanta s istim iznosom | što je trebalo napraviti |
|---|---|---|---|---|
| #68 | 17:56:51 | 1,02 | `z232pb646itg`, kreiran 70 s prije, još otvoren | jedinstven pogodak |
| #70 | 20:49:06 | 1,00 | `sqbwkeratgmm`, `nycwuw2m6u4t`, oba istekla ~7 min ranije | dva kandidata, **ista adresa** |
| #71 | 21:05:11 | 1,00 | `nycwuw2m6u4t` (drugi je preuzeo #70) | jedinstven pogodak |

Sve tri uplate imale su jednoznačno odredište. Rail je imao sve podatke da ih
proslijedi sam.

## Odluka

1. **Zalutala uplata** je ona čiji memo i `referenceNumber` nemaju ni adresu, ni
   sid, ni id kampanje. Goli `0x…` / `gnosis:` memo **nije** zalutala uplata:
   platitelj je naveo odredište koje odbijamo, a pogađati neko drugo bilo bi
   gore od parkiranja.
2. **Kandidati** su intenti tenanta čiji je IBAN primio novac. Moraju imati
   **točno** isti `amount_cents` i biti kreirani u prozoru
   `[placedAt − 48 h, placedAt + 2 min]`. Moraju biti `pending` ili `expired`
   bez namire, i ne smiju već imati živi forward.
3. **Odluka:**
   - svi kandidati vode na istu adresu → forward;
   - kandidati vode na različite adrese → park, a alert ispisuje kandidate;
   - nema kandidata → park.
4. **Redoslijed za pripisivanje:** prvo intent koji je bio otvoren u trenutku
   uplate, zatim najnoviji. Forward uzima prvi nezauzeti kandidat.
5. **Gate se ne zaobilazi.** Iz kandidata se sastavi `mpt:` routing (adresa i sid
   intenta) i on prolazi isti `authorizeForward` kao memo: tenant, whitelist,
   kapica i mint adresa.
6. **Zasun po intentu:** `ux_forwards_resolved_sid` dopušta najviše jedan živi
   `auto`/`manual` forward po sid-u. Dvije istovremene uplate istog iznosa ne
   mogu uzeti isti intent; gubitnik prelazi na sljedeći kandidat ili se parkira.
7. **Trag:** `monerium_forwards.memo_prefix` = `auto` (resolver) ili `manual`
   (admin). Svako povezivanje šalje Telegram alert 🔀. Kad je bilo više kandidata
   s istom adresom, alert to navodi uz ⚠️.
8. **Park uvijek prijavljuje ono što je platitelj stvarno poslao.**
   `forward.blocked` webhook nikad ne imenuje intent kojem uplata samo *možda*
   pripada.
9. **Ručno preusmjeravanje:** u `/admin/forwards` parkirani red ima gumb
   „Preusmjeri…“. Gumb prikazuje intente tenanta oko vremena uplate, bilo kojeg
   iznosa, a isti iznos ide prvi. `POST /admin/api/orders/:id/reroute {sid}`
   pokreće isti forward put s odabranim sid-om, pa i tu odlučuje gate.
10. **Prekidač:** `STRAY_RESOLVER = "1"` u `wrangler.toml`. Vrijednost `"0"`
    vraća staro ponašanje; ručni gumb radi neovisno o prekidaču.

## Zašto je to sigurno

Resolver ne izmišlja odredište. Svaka adresa koju predloži je `target_address`
intenta koji je tenant sam kreirao autentificiranim API pozivom, i ta adresa i
dalje mora proći whitelist. Napadač bez API pristupa ne može stvoriti kandidata.

Može pogriješiti samo **pripisivanje** između intenata iste adrese: koji od njih
postane `paid` i koji merchant webhook ode. Novac u tom slučaju ipak sleti tamo
kamo bi ga poslao bilo koji od kandidata.

## Poznata ograničenja

- **Trajni QR kampanje (`cmp:`, iznos upisuje platitelj).** Ako Revolut ispusti
  i taj memo, a slučajno postoji intent istog tenanta s točno tim iznosom i
  drugom adresom, resolver će uplatu poslati na tu adresu. Šteta je ograničena
  na pogrešnu namjenu **unutar istog tenanta**, nikad na tuđi novac:
  - kandidati dolaze samo iz tenanta čiji je Monerium račun (IBAN) primio
    uplatu, a ADR 0017 daje svakom tenantu vlastiti Monerium račun, rail,
    relayer i 1..N namjenskih Safe-ova;
  - odredište mora biti na whitelisti tog tenanta, dakle jedan od njegovih
    Safe-ova;
  - tenant može naknadno ručno prebaciti novac između svojih Safe-ova. To vrijedi
    za Safe-ove koje tenant kontrolira; Safe s vanjskim vlasnikom (npr. 1/1
    passkey Safe kampanje) treba potpis tog vlasnika.

  Zato je to prihvatljiv rizik, a ne razlog za isključivanje resolvera. Ako se
  počne događati, rješenje je učenje platitelja (sljedeći korak), ne gašenje
  `STRAY_RESOLVER`.
- **Krivo upisan iznos** se ne povezuje automatski. Za to služi ručni gumb.
- **Memo sa sid-om, ali bez adrese** se i dalje parkira. Tu je sid jači signal
  od iznosa, pa je to kandidat za zasebnu odluku.

## Sljedeći korak (zaseban PR)

Frontend šalje trajni `client_ref` pri `POST /api/intents`. Kad uplata prođe
preko sid-a, server zapiše vezu `client_ref` → `hash(pepper + IBAN)`; sirovi
IBAN se ne sprema, po obrascu `PHONE_PEPPER`. Kandidati povezani s IBAN-om
platitelja tada idu prvi. To rješava istovremene uplate istog iznosa od
različitih ljudi, a otvorena checkout stranica (SSE) daje dodatni signal da je
intent „živ“.

## Implementacija

| Stavka | Status |
|---|---|
| Resolver + gate + zasun (migracija 0018) | ✅ grana `feat/stray-resolver` |
| Admin „Preusmjeri…“ | ✅ grana `feat/stray-resolver` |
| Replay 7. 10. u testovima (`test/strayResolver.test.ts`) | ✅ |
| Migracija 0018 na produkciji | ⏳ |
| `client_ref` + učenje platitelja | ⏳ |
