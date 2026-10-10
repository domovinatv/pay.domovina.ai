#!/usr/bin/env bash
# Backward-compatibility check: run the tests of an OLDER commit (default:
# the merge base with origin/main) against the CURRENT code.
#
# Every failure is a place where behaviour (or a test-facing interface)
# changed since that commit. That is fine when intended — but it must be
# intended: CI fails the PR unless it carries the `behavior-change` label, and
# the PR description says which old test broke and why.
#
#   scripts/compat-check.sh                 # base = merge-base with origin/main
#   scripts/compat-check.sh <commit|tag>    # e.g. the commit that is in production
#
# Packages: backend, shopify/worker, wallet (functions tests). A package whose
# tests did not exist yet at the base is skipped.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
BASE=${1:-$(git merge-base HEAD origin/main)}
BASE_SHA=$(git rev-parse "$BASE^{commit}")
WORK=$(mktemp -d "${TMPDIR:-/tmp}/compat-check.XXXXXX")
trap 'git -C "$ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || rm -rf "$WORK"' EXIT

echo "compat-check: tests from $(git log -1 --format='%h %s' "$BASE_SHA")"
echo "              code from  $(git log -1 --format='%h %s' HEAD)"
git -C "$ROOT" worktree add --quiet --detach "$WORK" HEAD
# Uncommitted local changes count as "current code" too.
git -C "$ROOT" diff HEAD | (cd "$WORK" && git apply --allow-empty 2>/dev/null || true)

fail=0
run() {
  local pkg=$1 testdir=$2
  if ! git -C "$ROOT" cat-file -e "$BASE_SHA:$pkg/$testdir" 2>/dev/null; then
    echo "· $pkg: no tests at base — skipped"
    return
  fi
  # Old tests replace the new ones; everything else (src, deps) is current.
  rm -rf "${WORK:?}/$pkg/$testdir"
  git -C "$WORK" checkout --quiet "$BASE_SHA" -- "$pkg/$testdir"
  ln -sfn "$ROOT/$pkg/node_modules" "$WORK/$pkg/node_modules"
  echo "· $pkg: running old tests against current code…"
  if (cd "$WORK/$pkg" && npx vitest run "$testdir" --reporter=dot >"$WORK/$(echo "$pkg" | tr / _).log" 2>&1); then
    echo "  ✓ all old tests pass"
  else
    fail=1
    echo "  ✗ old tests that no longer pass:"
    grep -E "^ (FAIL|×)|✗|×" "$WORK/$(echo "$pkg" | tr / _).log" | sed 's/^/    /' | head -60
    grep -E "Tests +[0-9]" "$WORK/$(echo "$pkg" | tr / _).log" | sed 's/^/    /'
  fi
}

run backend test
run shopify/worker test
run wallet functions/__tests__

if [ "$fail" = 1 ]; then
  echo
  echo "Behaviour changed relative to $BASE_SHA. If intended: label the PR"
  echo "'behavior-change' and list each broken old test + why in the description."
  exit 1
fi
echo "No old test broke — backward compatible with $BASE_SHA."
