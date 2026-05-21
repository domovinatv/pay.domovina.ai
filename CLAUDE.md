# Project rules for Claude Code

## Parallel sessions — always use `git worktree`

If the user mentions another Claude Code session running in parallel (or you
detect one — e.g. unexpected modifications appear in `git status`, a commit
lands during your session, files you didn't touch show as modified), **stop
and switch to a `git worktree` before continuing**.

Why this matters: parallel sessions sharing the same checkout share one
working tree and one git index. A `git commit -am` (or `git add -A`) from
either session grabs **all modified files in the working tree**, including
the other session's staged-but-not-yet-committed changes. The result is
one commit with the wrong title relative to its diff — functionally fine
but messes up history and PR readability. Happened on `094f513` in PR #1.

Setup (do this for each session):

```bash
# Session A (e.g. payment-registry work)
git worktree add ../pay.domovina-payment-registry feat/payment-registry-onchain
cd ../pay.domovina-payment-registry

# Session B (e.g. admin-snackbar work)
git worktree add ../pay.domovina-snackbar feat/admin-snackbar
cd ../pay.domovina-snackbar
```

Each worktree has its own checkout + index + HEAD but shares `.git/objects`
with the main repo (one fetch, one disk footprint). No cross-contamination.

When the work merges, remove the worktree:

```bash
git worktree remove ../pay.domovina-payment-registry
```

If the user starts a parallel session without setting this up, proactively
offer to migrate to a worktree before doing any file edits.
