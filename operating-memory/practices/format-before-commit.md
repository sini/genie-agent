---
name: format-before-commit
description: Before any commit in a repository whose CI checks formatting (treefmt, nixfmt, mdformat); the false greens a formatter produces
type: practice
---

**Rule:** Run the repository's own formatter on the files you are committing, after the last
edit, against the exact revision you will land. Do not trust an earlier green, an agent's
reported green, or a green from inside a linked worktree.

**Why:** an unformatted commit is a guaranteed red CI. Four measured false greens:

1. **`nix fmt` run from a worktree nested inside the repository formats the MAIN checkout**
   and reports `0 changed` about a tree it never touched. The wrapper runs
   `treefmt --tree-root-file=.git/config`; in a linked worktree `.git` is a file, so the
   upward search skips it and lands on the main checkout. This put unformatted files into
   two pushed repositories, and it silently rewrites a tree another agent may be working in.
2. **Untracked new files are invisible to treefmt.** `0 changed` did not cover the one file
   the commit was adding. `git add` first, then format.
3. **`--ci` is fail-on-change, not check-only: it rewrites the tree.** A second run is
   always green, with the fix sitting unstaged. `git add` again after formatting.
4. **A later commit voids the reading.** An implementer reported `0 changed`, then made three
   more commits; two unformatted files were pushed.
   Also: a cold-cache `(N changed)` count is not an unformatted-file count. Judge by a repeat run
   reading 0 plus a clean `git status`.

**How to apply:**

- Format only the files you are committing. A repository-wide run reformats unrelated files
  (one config repository had 55 generated files with pre-existing drift), and the collateral
  rides into the commit.
- Use the repository's canonical entry point (`nix fmt <files>`, or the CI flake's formatter
  run from the directory CI uses), not a bare `treefmt` from PATH. A PATH treefmt with a
  different config enabled a lint that rewrote `{ x = cfg.x or [ ]; }` into
  `{ inherit (cfg) x; }`. That dropped a load-bearing default and broke evaluation.
- For worktree work, invoke the formatters directly on named paths, or run
  `treefmt --tree-root <git-archive extract of the landing rev> --walk filesystem --no-cache --fail-on-change`.
- Landing check: after merging, run the CI format command in the main checkout and require
  `0 changed` before pushing.
- A control that exits non-zero for the wrong reason (a usage error) has not fired. Discard
  the run.
- Do not rewrite a standing instruction on one agent's unreproduced claim. Reproduce it with
  a live control first.

Related: \[[one-writer-per-checkout]\] \[[ci-gate-discipline]\]
