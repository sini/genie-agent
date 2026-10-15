---
name: flake-check-running-zero
description: When citing a `nix flake check` pass, or planting a seeded red to prove a check discriminates
type: trap
verified: 2026-10-15; Nix 2.34.8, Determinate Nix 3.23.1, Lix 2.95.3
---

**Rule:** When you cite a `nix flake check` pass, quote `running N flake checks` with N > 0, or build /
evaluate the checks directly. Arm the claim with a seeded red in the same run, and confirm the seed
CHANGED the check's derivation path: an unchanged drv with rc 0 means the plant never reached it.

**Why:**

- Measured on a probe flake, four calls: first build exit 0 `running 1`; unchanged repeat exit 0
  `running 0` (cache hit); seeded red exit 1 `running 1`; reverted exit 0 `running 0`. The skip is
  SOUND: a store output exists only for a derivation that already built, and the hash covers every
  input. But the reader cannot tell a fresh pass from a cache hit. Re-measured 2026-10-15: Nix and
  Determinate print `running 0` on the warm repeat; Lix 2.95.3 prints `running 1` on both runs, so on
  Lix the count does not reveal a cache hit either way. A hosted CI runner starts from an
  empty store so it usually reads `running N`, but a store-path cache action could substitute.
- The real trap is a change that never reaches a derivation at all: an untracked file is outside the
  git-filtered flake source, so the drv is unchanged, warm, `running 0`, green.
- A red seed planted in `ci/README.md` to arm a README check did not move the derivation, and the check
  read rc 0, indistinguishable from a check that cannot discriminate. Cause: in that sub-flake,
  `self.sourceInfo.outPath` resolved to the REPOSITORY ROOT, not `ci/`, so the check read the root
  README. Re-seeded at the root: drv moved, rc 1. Caught by reading the check's manifest and `cmp`-ing
  store paths, not by reading the rc.

**How to apply:**

- `nix flake check ./ci 2>&1 | tee log; grep -o 'running [0-9]* flake checks' log`
- Or evaluate every `checks.<system>.<cell>.drvPath` (a throwing assert means clean eval IS the
  assertion) and drive one cell red in the same run:

```sh
before=$(nix eval --raw ./ci#checks.x86_64-linux.<name>.drvPath)
# plant the seed (git add it)
after=$(nix eval --raw ./ci#checks.x86_64-linux.<name>.drvPath)
[ "$before" != "$after" ] || echo "SEED DID NOT REACH THE CHECK"
```

- Guard untracked files with a wrapper that refuses on any git-unknown file under the source roots.

Related: \[[nix-flake-filtered-tree-and-eval-cache]\] \[[nix-unit-collection-traps]\] \[[check-output-is-not-its-population]\]
