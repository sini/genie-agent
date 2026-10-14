---
name: gen-demo
description: Working in gen-demo, the acceptance corpus that exercises every landed gen component through the hub's published surface.
type: reference
---

**Purpose:** the **integration corpus** for gen. It is a consumer, not a library: no library code of its
own, the gen hub as its only input of note, and no direct pin on any `gen-*` member. It drives the hub
the way den v2 will (through `flakeModules.default` and `flakeModules.genLibs`), so an integration error
between landed components reads RED in a repository whose only job is to notice, rather than three
layers deep inside a framework. It belongs to no fleet and no machine; nothing here is a configuration
anyone runs.

**The growth rule:** the corpus grows **one declaration per landed component, in the same landing.** A
component that lands without adding or changing the declaration that exercises it has not been shown to
integrate. The corpus is the live half of a component's exit criterion.

**The naming rule:** gen names no entities. There is no host, user or service in the substrate, so
every kind, node and aspect name is a nonsense word (`bobbin`, `pewter`, `damask`, …).
Declaring a framework's vocabulary would import that framework's model into gen's acceptance criteria.

**Depends on:** the gen hub only (`nixpkgs` follows the hub's). Libraries are reached as module args
(`genScope genGraph genSelect genAlgebra genBind genDispatch genAspects genSchema`) or through the hub's
stratum buckets (`substrate.view`, `framework.program`, `framework.delivery`, `substrate.product`, …).

## Layout

- `index/<name>.nix`: one file per construct, `{ title; adr; what; }`. The construct table is
  **generated** (`nix build .#construct-index`), never hand-written.
- `constructs/<name>.nix`: a function whose formals are the names it reads, returning the names it
  declares. All construct files plus module args form one namespace; a name declared twice, or read but
  never declared, is refused naming the file.
- `cells/<check-name>.nix`: one check per file, `{ asserts, … }: { construct = [ "<name>" ]; check = asserts (…); }`, with a header comment saying what it asserts and what would turn it red.
- `ci/refusals/<name>.sh`: planted-violation rows, each with a planted (red, by name) and an unplanted
  (green) arm. `ci/tests/refusals-pairing.nix` reds a one-sided row.
- `gen-modules/corpus.nix`, `aspect-cnf.nix`, `fixtures/`, `legacy-ids.nix` (old ids and renames resolve
  here; frozen maps are never edited, only `renamed` entries added).

## Working in it

```sh
ci              # guarded: refuses any untracked file under a read root, then runs ci/tests
check-lock      # nix flake check (root plane) AND nix flake check ./ci -- unguarded
check-hub-main  # the same against the hub's current main (--override-input gen) -- unguarded
refusals        # every planted violation, read by name, each with its unplanted control
build-target    # full system build of the one target; on demand, not a check
```

- **Two check planes.** `nix flake check` covers only the plane its argument names. While the arms ran
  the root plane alone, a seeded red in `ci/` left them printing "all checks passed!". Each arm now runs
  both and prints both exit codes (`root=0 ci=0`). Under `set -euo pipefail` that is `|| rc=$?`, not
  `cmd; rc=$?`, which exits on the first red without the summary.
- The committed `flake.lock` is the **last-green pin**; `check-hub-main` shows a hub landing that breaks the
  corpus immediately, without waiting for a relock.
- Refusal messages are unreadable to `checks.default` (`tryEval` yields only `success`), so `refusals`
  runs out of band, in its own CI workflow step. CI uses `REFUSALS_ENGINE=process` so each evaluator
  column reads refusals in its own words.
- Drive a new cell with `nix flake check --no-build` before landing: a store write (`builtins.toFile`)
  greens locally and reds in CI.
- **Adding** anything means new files with a name you choose (`[a-z0-9-]+`, the kebab of its title). No
  number is drawn and no list or count is edited by hand, so parallel units collide only as same-path
  adds that git reports. In refusal scripts, write hyphens in the `row_<name>` variable as `_`.

## Invariants and lessons

- `construct-index` requires every index entry to be named by a cell and vice versa, and reports how many
  it compared against how many it expected, never a bare pass.
- **Census reach by evaluation, not by text.** A roster member counts as reached only if poisoning its
  `lib` with a run-unique `throw` reds at least one cell. Keep a negative control: a member the corpus
  is known not to force must stay green under its poison, proving the instrument discriminates.
- A cell over a returned record must read the **result's** fields, not its argument, or it exercises only
  the library that built the argument.
- Pin an unmoved identity against a **literal**, not by comparing two values the same edit would move.
- Silent-empty failures are findings. The hub once hardcoded the node-registry name `hosts`, and any
  other name projected an **empty** configuration set with no error. It now takes the path from the
  consumer (`gen.nodeRegistryPath`).
- Record what the corpus finds against the hub (stale docs, aborts where a contract promises a miss)
  in the repository; an acceptance corpus that swallows what it finds is not one.
