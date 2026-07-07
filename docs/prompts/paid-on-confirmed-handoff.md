# HANDOFF — „Plaćeno" tek na on-chain potvrdi (MPT rail)

_Pokreni u zasebnoj Claude Code sesiji. Nakon implementacije radimo review u
glavnoj sesiji. Follow-up na payment-status-timeline (mergano u main 67ec7ca)._

---

## 0. Prvo: git worktree (OBAVEZNO — projektno pravilo)

```bash
git worktree add ../pay.domovina-paid-confirmed feat/paid-on-confirmed
cd ../pay.domovina-paid-confirmed
```

## 1. Problem (poslovna odluka je već donesena — opcija A)

Na MPT railu trenutno: čim relay **broadcasta** forward transakciju (EURe →
primatelj preko Safe + Zodiac Roles), sustav odmah flipa intent na `paid` i
okine **merchant webhook „plaćeno"** — a to je na *broadcastu*, ne na
*on-chain potvrdi*. Ako forward tx kasnije **revertira**, trgovac je već
dobio „plaćeno" dok je novac zapravo zaglavio u MPT Safeu (povrativ, ne
izgubljen). Timeline UI (`stage=settled`) već čeka `confirmed`, pa se
„paid" (trgovac) i „settled" (UI) razilaze.

**Cilj:** paid-flip **I** merchant webhook okidaju tek kad je forward
**`confirmed`** on-chain. „Plaćeno" postaje istinito i poravnato sa `settled`.

## 2. Kritična zamka — potvrda mora biti SERVER-DRIVEN

`confirmForwardIfMined` (`intents/stage.ts`) trenutno potvrđuje forward samo
kad **netko polla** status endpoint (checkout/Flutter). **NE smiješ** vezati
paid-flip isključivo za taj put — ako nitko ne gleda, „plaćeno" se nikad ne
okine. Potvrda mora doći iz servera neovisno o gledatelju. Dva mehanizma:

1. **Primarno — u `handleForward` (`backend/src/index.ts`, `waitUntil` put):**
   nakon što `forwardViaSafe` uspješno broadcasta (status `submitted`),
   u **istom** `waitUntil` pollaj `getForwardStatus` (`router/safe.ts:217`) s
   backoffom do razumnog timeouta (npr. ~60–90 s):
   - `confirmed` → `updateForward('confirmed')` **+ markIntentPaid + merchant
     webhook** (i `cmp:` contribution webhook za campaign QR).
   - `failed` → `updateForward('failed', error)`. **NE** flipaj paid, **NE**
     šalji webhook (opcija A ne uključuje reversal webhook — to je zaseban
     mogući follow-up).
   - timeout/`unknown` → ostavi `submitted`; cron (dolje) će dovršiti.
2. **Backstop — cron sweep:** postojeća cron infra (uz `sweepExpiredIntents`,
   `index.ts`) — periodično prođi `monerium_forwards` sa `status='submitted'`
   starije od praga, reconcile preko `getForwardStatus`, i na `confirmed`
   izvrši **isti** paid+webhook put. Pokriva slučaj gdje je Worker evictan
   prije nego `waitUntil` await završi.

`confirmForwardIfMined` na read-putu **ostaje** kao još jedan (tercijarni)
izvor potvrde — ali paid+webhook logika mora biti **idempotentna i
single-fire** bez obzira koji put prvi potvrdi.

## 3. Idempotentnost i rubovi (OBAVEZNO)

- **markIntentPaid single-fire:** flip smije `pending → paid` samo jednom;
  ako je već `paid`/`expired`, no-op. (Provjeri postojeći `markIntentPaid`,
  `intents/db.ts` — dodaj guard ako ga nema.)
- **Merchant webhook točno jednom:** `emitIntentPaidWebhook` već ima
  idempotency — potvrdi da se ne može poslati dvaput kad i primarni put i
  cron potvrde isti forward (npr. emitiraj tek unutar iste transakcije koja
  flipa paid, ili čuvaj `webhook_sent` flag).
- **Put BEZ forwarda (direktni mint / bare `0x` / self-target noop):** nema
  on-chain forwarda za čekati — paid ovdje mora ostati vezan za **Monerium
  mint `processed`** (koji je već on-chain potvrđen). NE regresiraj taj put:
  routed rail = paid na forward `confirmed`; ne-routed rail = paid na order
  `processed`. Provjeri kako `handleForward` danas rukuje `self_target_noop`
  i `confirmed`/`failed` bez broadcasta.
- **Monerium webhook gating netaknut:** forward se i dalje pokreće samo na
  `kind='issue' && order.updated && state='processed'` (`index.ts:222`). Ne
  diraj to.
- **Kasna SEPA nakon isteka intenta:** i dalje se forwarda (novac uvijek
  ruta); ako intent istekne prije potvrde, ne „uskrsavaj" ga u paid osim ako
  je to postojeće ponašanje — uskladi s `markIntentPaid` semantikom.

## 4. Posljedica na stage machine (trebalo bi već štimati)

`stage.ts` već mapira `settled` = forward `confirmed`. Nakon ove promjene
`paid` (trgovac) i `settled` (UI) se poravnavaju. Provjeri da timeline i
dalje pošteno prikazuje `forwarding` dok čeka potvrdu, i `settled` tek na
`confirmed`. Ne treba mijenjati `computeStage`.

## 5. Verifikacija (obavezno)
- `cd backend && npm test` — proširi `test/` (postoji vitest, 14 testova):
  - webhook/paid okidaju na `confirmed`, NE na `submitted`.
  - forward `failed` → intent NIJE `paid`, webhook NIJE poslan.
  - ne-routed (direktni mint) → paid na order `processed` (bez forwarda).
  - dvostruka potvrda (primarni put + cron) → paid flipnut jednom, webhook
    poslan jednom (idempotencija).
- `npm run typecheck` (ili `npx tsc --noEmit`) čist.
- Ako diraš cron: potvrdi da se registrira i da sweep ne baca na praznom setu.
- Ručno (wrangler dev + seed D1): submitted → confirmed put okine paid+webhook;
  submitted → failed ne okine.

## 6. Izvan opsega
- Reversal / „uplata poništena" webhook (to je bila opcija B — nije izabrana).
- SSE/DO push, SMS notifikacija.
- Mijenjanje Monerium webhook gatinga ili stage enuma.

## 7. Predaja
Commit + push na `feat/paid-on-confirmed` (auto-push odobren). Sažmi: koje
fileove si dirao, gdje točno sad okida paid+webhook, kako je osigurana
single-fire idempotencija (primarni put vs cron vs read-path), i koji testovi
pokrivaju to. Vraćamo se u glavnu sesiju na review.
