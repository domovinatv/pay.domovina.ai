# Zaštita `main` grane (GitHub Rulesets)

`main` u `domovinatv/pay.domovina.ai` štite dva ruleseta. Definicije su u repou:

- [`.github/rulesets/main-hard.json`](../../.github/rulesets/main-hard.json): **tvrdo**, nitko ga ne zaobilazi
- [`.github/rulesets/main-pr-ci.json`](../../.github/rulesets/main-pr-ci.json): **PR + CI**, admin ga zaobilazi

Aktivirano 2026-10-15: `main — tvrdo` id `25142672`, `main — PR + CI` id `25142673`.

---

## 1. Zašto dva ruleseta

Bypass se na GitHubu odnosi na **cijeli** ruleset, ne na pojedino pravilo. Repo ima
jednog suradnika (`stepanic`, admin), a pod njegovim credentialsima rade i agenti
(Claude Code, Antigravity). Jedan ruleset s admin bypassom `always` zato ne bi
spriječio ništa: ni force-push ni brisanje `main`-a.

Zato je podjela:

| Ruleset | Pravila | Bypass |
|---|---|---|
| `main — tvrdo` | `deletion`, `non_fast_forward`, `required_signatures` | nitko, ni admin |
| `main — PR + CI` | `pull_request`, `required_status_checks` | admin, `always` |

Posljedica: izravni push na `main` i dalje radi (radni tok „slobodno uvijek
pushaj“). GitHub pritom javlja da je PR + CI ruleset zaobiđen. Force-push,
brisanje grane i nepotpisani commit ne prolaze nikome.

---

## 2. Pravila

### 2.1. `main — tvrdo`
- **`deletion`**: `main` se ne može obrisati.
- **`non_fast_forward`**: nema `git push --force` ni prepisivanja povijesti.
  Ako treba popraviti nešto što je već na `main`-u, napravi novi commit (revert).
- **`required_signatures`**: svaki commit na `main` mora biti potpisan
  (GPG/SSH/S/MIME). Lokalno je `commit.gpgsign=true`. Merge i squash commitove iz
  GitHubova sučelja potpisuje GitHub (`web-flow`), pa i oni prolaze.
  **Rebase merge** u sučelju je onemogućen, jer GitHub prepisane commitove ne
  može potpisati. Koristi merge ili squash.

  Ako `git push` padne s `Commits must have verified signatures`, commit je
  nastao bez potpisa (npr. alat koji ne čita `commit.gpgsign` ili GPG agent nije
  bio otključan): `git commit --amend -S --no-edit` (ili `git rebase --exec 'git
  commit --amend -S --no-edit' origin/main` za više njih) prije pusha.

### 2.2. `main — PR + CI`
- **`pull_request`** s `required_approving_review_count: 0`. GitHub autoru ne
  dopušta da sam odobri svoj PR, pa bi `1` blokirao solo maintainera. PR se i
  dalje traži za sve što nije admin bypass.
- **`required_review_thread_resolution: true`**: otvoreni komentari na PR-u
  blokiraju merge.
- **`required_status_checks`**: svih pet jobova iz
  [`ci.yml`](../../.github/workflows/ci.yml), vezanih na GitHub Actions
  (`integration_id: 15368`), da ih druga aplikacija ne može lažno zazeleniti:
  1. `backend (tsc, vitest, bundle)`
  2. `shopify worker (tsc, vitest)`
  3. `wallet (tsc, relayer tests)`
  4. `flutter (analyze, test)`
  5. `backward compatibility (old tests vs new code)` (vidi `docs/testing.md`;
     oznaka `behavior-change` propušta namjernu promjenu ponašanja)
- **`strict_required_status_checks_policy: false`**: PR ne mora biti ažuran s
  `main`-om prije merga. Uz paralelne sesije i PR-ove `true` bi tjerao novi CI krug
  nakon svakog merga.

**Preimenovanje joba u `ci.yml`** mora ići zajedno s izmjenom
`main-pr-ci.json` i ponovnom primjenom (korak 3). Inače PR zauvijek čeka check
koji više ne postoji.

---

## 3. Primjena i izmjene

JSON u repou je izvor istine. Prva primjena:

```bash
for f in main-hard main-pr-ci; do
  gh api repos/domovinatv/pay.domovina.ai/rulesets --method POST \
    --input .github/rulesets/$f.json --jq '.id, .name'
done
```

Izmjena postojećeg (id iz `gh ruleset list`):

```bash
gh api repos/domovinatv/pay.domovina.ai/rulesets/<id> --method PUT \
  --input .github/rulesets/main-pr-ci.json
```

Provjera:

```bash
gh ruleset list
gh ruleset check main
```

Za probu bez blokiranja postavi `"enforcement": "evaluate"`. Na Free planu
organizacije evaluate mode možda nije dostupan, a tada GitHub vraća grešku na
PUT/POST.
