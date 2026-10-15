# Zaštita `main` grane (GitHub Ruleset)

Ovaj dokument opisuje preporučeni GitHub Ruleset za zaštitu produkcijske grane `main` u repozitoriju `domovinatv/pay.domovina.ai` te sadrži upute za primjenu bez potrebe za ručnim klikanjem po GitHub web sučelju.

Konfiguracijska datoteka nalazi se u [`.github/rulesets/main-branch.json`](file:///.github/rulesets/main-branch.json).

---

## 1. Analiza i trenutno stanje

Pregledom repozitorija putem `gh` CLI-ja (`gh api repos/domovinatv/pay.domovina.ai/rulesets` i `gh api repos/domovinatv/pay.domovina.ai/branches/main/protection`):
- `main` grana nema definiranu branch protection zaštitu niti aktivan ruleset.
- Svi commitovi održavatelja (`stepanic`) potpisuju se GPG ključem (`RSA F9968089DBE3338732A53F663420E392053523AF`).
- Postoji CI cjevovod ([`.github/workflows/ci.yml`](file:///.github/workflows/ci.yml)) s 5 paralelnih poslova koji provjeravaju tipove, testove, dry-run bundle i kompatibilnost starih testova prema novom kodu.
- Organizacija i repozitorij imaju jednog primarnog održavatelja/admina (`stepanic`).

---

## 2. Dizajn pravila

Ruleset kombinira maksimalnu sigurnost produkcijskog koda uz nesmetan rad solo maintainera:

### 2.1. Zabrana destruktivnih radnji
- **`deletion`**: Onemogućava slučajno ili zlonamjerno brisanje `main` grane.
- **`non_fast_forward`**: Blokira `git push --force` i prepisivanje povijesti na `main`.

### 2.2. Kriptografski integritet (`required_signatures`)
- Zahtijeva da svaki commit na `main` bude kriptografski potpisan (GPG / SSH / S/MIME). Budući da se u repou već koristi verificirani GPG potpis, ovo trajno štiti od ubacivanja nepodržanih commitova pod tuđim identitetom.

### 2.3. Obvezan Pull Request tok (`pull_request`)
- **`required_approving_review_count: 0`**:
  - *Važno za solo održavatelja*: GitHub po dizajnu brani autoru PR-a da sam sebi odobri vlastiti PR. Postavljanje broja recenzenata na `1` onemogućilo bi samostalno spajanje PR-ova.
  - Vrijednost `0` osigurava da sav kod mora proći kroz Pull Request mehanizam (nema slučajnog direktnog pusha na `main`), omogućuje pokretanje CI-ja i compat-checka, a održavatelj može samostalno dovršiti spajanje.
- **`dismiss_stale_reviews_on_push: true`**: Novi push poništava eventualna prethodna odobrenja.
- **`required_review_thread_resolution: true`**: Svi komentari i rasprave na PR-u moraju biti označeni kao riješeni prije spajanja.

### 2.4. Obvezne CI provjere (`required_status_checks`)
- **`strict_required_status_checks_policy: true`**: Zahtijeva da je grana ažurirana sa zadnjim commitom na `main` prije merganja (sprečava race conditione).
- Obvezni status checkovi (iz `.github/workflows/ci.yml`):
  1. `backend (tsc, vitest, bundle)`
  2. `shopify worker (tsc, vitest)`
  3. `wallet (tsc, relayer tests)`
  4. `flutter (analyze, test)`
  5. `backward compatibility (old tests vs new code)`

### 2.5. Bypass ovlasti (`bypass_actors`)
- Uloga `RepositoryRole: 5` (Admin) ima pravo zaobilaženja (`bypass_mode: "always"`), što omogućuje hitne intervencije ili hotfixeve u izvanrednim situacijama.

---

## 3. Postupak primjene (kada se odluči aktivirati)

Datoteka pravila pripremljena je u `.github/rulesets/main-branch.json`. Za primjenu na GitHub pokrenuti:

```bash
gh api repos/domovinatv/pay.domovina.ai/rulesets \
  --method POST \
  --header "Accept: application/vnd.github+json" \
  --input .github/rulesets/main-branch.json
```

### Provjera nakon primjene:
```bash
# Popis aktivnih ruleseta
gh ruleset list

# Provjera pravila koja se primjenjuju na main granu
gh ruleset check main
```

### Testni mod (Evaluate mode)
Ako se pravila prije pune primjene žele promatrati u pasivnom načinu (bilježi prekršaje bez blokiranja operacija), u `.github/rulesets/main-branch.json` promijeniti:
```json
"enforcement": "evaluate"
```
te ponovno poslati ili ažurirati ruleset putem `gh api --method PUT repos/domovinatv/pay.domovina.ai/rulesets/<id>`.
