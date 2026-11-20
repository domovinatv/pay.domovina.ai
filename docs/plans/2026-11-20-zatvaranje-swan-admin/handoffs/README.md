# Handoffi S1–S8 — zatvaranje Swan / ADR 0032 i admin v2

Plan je u [../plan.md](../plan.md), odluke u [../decisions.md](../decisions.md), lista u
[../TODO.md](../TODO.md). Matija nakon `/clear` kaže „nastavi zatvaranje swan” (ili „nastavi
zadnji handoff”); to znači prvi otvoreni red u „Stanje lanca”.

## Lanac

1. Sesija N počinje iz `handoffs/SN.md`.
2. Sesija N radi svoj paket po pravilima ispod.
3. Na kraju sesija N:
   - označi `SN` u „Stanje lanca” (commit, testovi, napomena) i stavke u `TODO.md`;
   - ako je naučila nešto što mijenja sljedeće pakete, uredi `S(N+1).md` (i po potrebi kasnije
     handoffe i plan). Nedovršeni dio paketa N ide na **vrh** `S(N+1).md`;
   - u `S(N+1).md` upiše polazni commit i brojke testova;
   - pozove `/wrap-up`; handoff prompt je **sadržaj `S(N+1).md`**.
4. Bez konteksta usred paketa: nastavak je opet `SN` s popisom ostatka na vrhu. Broj se ne povećava.
5. **Vrata** (S3, S4, S6, S7): sesija pripremi sve, pitanje upiše na vrh sljedećeg handoffa i
   lanac staje dok Matija ne odgovori.
6. Handoff se mijenja samo prema naprijed; gotovi `SN` ostaju kao povijest.
7. S5 (Flutter) smije ići paralelno u svom worktreeu; red u tablici upisuje tko završi.

## Stanje lanca

| Sesija | Paket | Stanje | Commit | Testovi | Napomena |
| --- | --- | --- | --- | --- | --- |
| S0 | Plan | gotovo | e96296e | backend 889 | plan, koda nema |
| S1 | Mjerenje inboxa + guardovi | gotovo | 0515534 (#170) | backend 896 | deploy df9f84b9; inbox vezan (1 uplata), odstupanja 0 prije i poslije; `settledSql` OR (odl. 101) |
| S2 | Čitatelji fiat namire | gotovo | 37e3972 (#171) | backend 905 | deploy c1888f30; `fiatSettlementOrder` u statusu i v2 detalju; prod 4/4 Swan isto (odl. 200–206) |
| S3 | settleFiat bez sintetskog ordera | gotovo | f95d74e (#172) | backend 916 | vrata odobrena 20. 11.; deploy bdcd7f0b + mig. 0037 (4+4 reda obrisana); živa Swan sandbox `x22x58fvjk8s` → paid, 0 `swan_` ordera, namira vezana (odl. 300–308) |
| S4 | Monerium kroz matcher | otvoreno | | | vrata |
| S5 | Flutter fiat tekstovi | otvoreno | | | paralelno |
| S6 | Swan IBAN/secret u v2 | otvoreno | | | vrata (tajne) |
| S7 | Crošulja + odluke | otvoreno | | | vrata (odluke) |
| S8 | Uklanjanje v1 | otvoreno | | | samo ako S7 kaže da |

## Zajednička pravila

- **Polazak:** `cd backend && npm run typecheck && npm test` zelen (jedna rečenica s brojem
  testova). Ako nije zeleno, prvo to popraviti.
- **Worktree:** `git worktree add -b <grana> ../pay.domovina-<tema> origin/main`, pa symlink
  `backend/node_modules`, `wallet/node_modules`, `shopify/worker/node_modules` iz glavnog checkouta.
  Glavni checkout se ne dira (paralelne sesije).
- **Opseg:** samo datoteke iz paketa. v1 admin (`backend/src/admin/views.ts`, `app.ts` v1 rute) se ne
  mijenja prije S8.
- **Regresijski ugovor:** `scripts/compat-check.sh` prije merga (gleda samo commitano). Stari testovi
  se ne mijenjaju, osim test doubleova za novo obavezno polje. Promjena ponašanja = PR s oznakom
  `behavior-change` i objašnjenjem svakog starog testa. Detalji `docs/testing.md`.
- **Orkestracija:** posao rade Opus 5.5 subagenti (`model: "opus"`): (a) implementacija, (b) testovi
  i spajanje. `effort` uvijek eksplicitno: `high` za kod, `medium` za čitanje. Najviše 2–3 paralelno.
  Fable samo ako ga Matija izričito traži. Agentima zabranjeni `TODO.md`, `plan.md`, `decisions.md`
  i handoffi — njih ažurira orkestrator.
- **Testovi:** bez mreže, `skipped 0`. Brojke uvijek s naredbom kojom su dobivene.
- **Produkcija:** čitanje D1 (`npx wrangler d1 execute pay_domovina --remote --command "SELECT …"`)
  je slobodno. Pisanje u D1, deploy koji mijenja put novca i sve s tajnama: prvo Matija.
  Deploy: `cd backend && npm run db:migrate:prod && npx wrangler deploy`. Deploy bez promjene
  ponašanja (compat-check zelen bez oznake) smije sam.
- **Sandbox uplate:** Monerium `curl -X POST https://api.mpt.hr/api/intents/<sid>/monerium-sandbox-transfer -d '{}'`;
  Swan gumb „Simuliraj uplatu (Swan)” na checkoutu sandbox tenanta `sbx-d166d9a98b`.
  Prvo `grep backend/src`, pa tek onda stare skripte u `tools/`.
- **Preglednik:** Brave `ms@ff.hr` (deviceId `80df9c18-1811-478c-80bc-8ead45619cfc`); admin prijavu
  passkeyem radi Matija. Nakon rada vrati `/admin/v2/mode/production`.
- **Autonomno:** odluči i zapiši u `decisions.md` (blok sesije), commitaj svaki zeleni korak; push
  je odobren. Nepovratno i vanjsko ostavi Matiji.
- **Token budget:** bez Monitora za napredak; dugi jobovi s `run_in_background`, javljanje tek na
  kraju. Oko 150k konteksta zatvori sesiju po koraku 3.
- **Istraživanja:** `../research/YYYY-MM-DD-*.md`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR završava s
  „🤖 Generated with [Claude Code](https://claude.com/claude-code)”.
- Repo je **javan**: bez cijena i uvjeta partnera, bez tajni, bez osobnih podataka uplatitelja.
