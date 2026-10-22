# ADR 0030 — Edge cache za javno čitanje (`/api/payers`): D1 ne smije nositi publiku

- **Status:** Accepted, implementirano 2026-10-22 (`backend/src/payers/api.ts`, `payersBody`)
- **Kontekst:** MPT rail (`backend/`), javni popis uplata projekta na energy.domovina.ai
- **Gradi na:** [0029](0029-javna-oznaka-uplatitelja.md)
- **Analiza:** energy.domovina.ai `docs/18-skalabilnost-javnog-citanja.md` (proračun, cjenik, korak 2)
- **Odluka vlasnika:** Matija Stepanic, 22. 10. 2026.

## Problem

Svaka otvorena stranica projekta svakih ~20 s poziva `GET /api/payers/:address`, a svaki
poziv je bio jedan D1 upit. D1 je jednonitna po bazi (pri 1 ms po upitu ~1.000 upita/s,
zatim red, pa `overloaded`). To je **ista baza** u kojoj se obrađuju Monerium webhook,
intenti i forwardi, pa bi navala gledatelja na kampanju zaustavila tok novca. Zaglavlje
`Cache-Control: public, max-age=5` nije pomagalo: Worker se izvršava ispred CDN-ova
cachea, pa ga CDN ne sprema sam od sebe.

## Odluka

Tijelo odgovora ide kroz Cache API (`caches.default`), po ključu
`<origin>/api/payers/<adresa malim slovima>`:

- svježe `PAYERS_FRESH_S = 10` s → iz cachea, bez D1;
- između 10 i `PAYERS_STALE_S = 60` s → vrati se staro, a osvježavanje ide u `waitUntil`;
- istovremeni promašaji u istom izolatu dijele jedan D1 upit (`inflight`);
- u cacheu je golo tijelo, a CORS zaglavlja ostaju od trenutnog zahtjeva.

D1 tako vidi najviše oko jedan upit po adresi u 10 s po podatkovnom centru, neovisno o
broju gledatelja.

## Posljedice

- Zaprimljena uplata na tuđem ekranu kasni do 10 s više. Prvi zahtjev nakon tišine može
  dobiti odgovor star do 60 s, a sljedeći je svjež. Isključivanje `public_payer_tags`
  djeluje s istim zakašnjenjem.
- Worker zahtjevi se i dalje naplaćuju. Ako javna kampanja to zatraži, sljedeći korak je
  snimka `payers/<safe>.json` u R2, pisana pri promjeni i posluživana kroz CDN s vlastite
  domene. Za to treba Cache Rule, jer CDN po zadanom ne sprema JSON (energy `docs/18` §5).
- Nasumične valjane adrese su uvijek promašaj, pa ostaju put do D1. Lijek je Rate Limiting
  pravilo na javnom `/api/*`, koje je još otvoreno.

## Odbačeno

- **Samo `s-maxage` na odgovoru**: CDN ne sprema odgovore Workera na istoj ruti.
- **KV kao cache**: globalan je, ali pisanje se širi do 60 s, a svako čitanje se naplaćuje.
  Cache API je besplatan i lokalan, a to je ovdje dovoljno.
- **WebSocket/SSE preko Durable Objecta**: promjena ima nekoliko na sat, pa je osvježavanje
  datoteke jednostavnije i jeftinije od otvorenih socketa.
