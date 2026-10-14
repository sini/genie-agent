---
name: check-output-is-not-its-population
description: When a failing check (including `nix flake check` without `--keep-going`) prints a list of failures and you are about to scope a repair or a count to it
type: trap
---

**Rule:** A printed failure list is a lower bound, never a population. Derive the full set of offending
sites with your own predicate and a live control, or rerun with `--keep-going` and count. Say "the
first failure is X", never "the failure is X".

**Why:**

- A README-audience check named 2 of 3 offending sites, because the third only became reachable once
  the first two were fixed. A repair scoped to the printed list would have re-reddened at the third. An
  independent sweep found all three.
- `nix flake check` without `--keep-going` stops at the first failing check. A consumer-repo arm was
  attributed to one failing cell. Fixing it left the arm still exit 1, now on a different cell that had
  been failing all along. The fix looked like it accomplished nothing, and the tempting reading ("the
  fix regressed something") was false: the mask lifted.
- The reverse is worse: a cell that reads green only because an earlier cell aborted first was never
  evaluated at all.
- Measured: one repo showed a single refusal to `flake check` and 104/108 with 1 error and 3 failures
  to nix-unit.

**How to apply:**

- `nix flake check ./ci --keep-going > log 2>&1; echo "rc=$?"`
- Diagnose test suites from `nix-unit --flake ./ci#tests 2>&1`, which names every cell.
- Run your own sweep; reconcile it with the check's output before claiming the repair is complete.

Related: \[[census-predicate-spans-shapes]\] \[[nix-which-flake-which-output]\] \[[flake-check-running-zero]\]
