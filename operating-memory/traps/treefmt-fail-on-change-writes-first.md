---
name: treefmt-fail-on-change-writes-first
description: Applies when using treefmt (or a pre-commit treefmt hook) as a format check.
type: trap
---

**Rule:** Treat `treefmt --fail-on-change` as "format, then report whether anything changed". Decide
"was the committed tree formatted" from exit 0 + 0 changed + a CLEAN `git status` in the same run.

**Why:** The flag does not mean check-only. It reformats in place, compares, and exits 1 if anything
changed, so afterwards the tree is formatted and the exit code describes the tree as it WAS. A second
pass cannot tell "was clean" from "I just cleaned it"; `git status` can, in one run. Control: at an
unformatted parent, exit 1, 1 changed, tree dirty.
This is also why a pre-commit treefmt failure ("unexpected changes detected, --fail-on-change is
enabled") leaves a dirty tree: the hook already rewrote the file.

**How to apply:**

- After a hook refusal: `git add` the reformatted file and commit again. Do not re-edit by hand. The
  second commit's run is the one that measures.
- As a check: `treefmt --fail-on-change; echo "rc=$?"; git status --porcelain` must be rc 0 and empty.

Related: \[[formatter-check-is-not-a-format-run]\]
