---
name: gen-harness
description: Working in gen-harness, the shared CI harness (mkCi) every gen library's ci/ flake is built from, or debugging a gen library's ci/devshell/hooks.
type: reference
---

**Purpose:** the CI harness for the whole gen ecosystem. `mkCi` wires flake-parts, nix-unit, treefmt,
a devshell and pre-commit hooks into a library's `ci/flake.nix`, adds the `flake.tests` /
`flake.testsError` options and the checks. It is TOOLING, not a gen library: off the library roster,
exports no semantics. Instrumental class: a usage count IS a valid deletion ground here.

**Depends on / used by:** inputs flake-parts, nix-unit, import-tree, treefmt-nix, git-hooks.nix. It
declares NO gen library input at either flake, by construction: every member's `ci/` pins the harness,
so a gen input here is a revision cycle no relock order can converge. It vendors exactly one prelude
function (`hasInfix`). Used by every gen member's `ci/` and by the hub.

**Layout:** root flake outputs only `lib`. `mkCi.nix`, `flakeModule.nix` (options, checks, hooks,
devshell), `readroots.nix`, `prelude.nix` (`hasInfix` only), `mdformat-plugins.nix`,
`staged-commit-hook.nix`, `relock.nix`, `lock-node.nix`, `example-graft.nix`,
`.github/workflows/evaluators.yml` (the reusable three-evaluator workflow), `evaluator-pins.sh`.
All gates live in `./ci`.

**API:**

- `lib.mkCi { inputs, name, testModules, readRoots ? [ ], specialArgs ? { }, extraModules ? [ ] }` (closed).
- Check builders for non-mkCi repos (pure in `pkgs`): `lib.checks.treefmtTreeRoot`, `mdformatPlugins`,
  `agentsMdCitations { pkgs, name, root, sheet ? "owed" }`, `ciPlaneCoverage`, `rootSurface`,
  `ciSelfInput`, `errorPlane`. Also `lib.relock`, `lib.processPlane`, `lib.readRootsGuard`,
  `lib.stagedCommitHook`, `lib.failMessage`, `lib.mdformatBasePlugins`, `lib.lockedRepo`.
- What `mkCi` gives a consumer:
  - `flake.tests.<suite>.<test> = { expr; expected; }`;
    `flake.testsError` for cells whose expr CAN ABORT (`expected` or `expectedError`).
  - Options under `gen.ci.*`: `agentsMd.sheet`, `commitHook.chained`, `rootSurface.{entry,retired,foreign}`,
    `evaluators`, `examples`, `examplesExcluded`, `mdformat.extraPlugins`.
  - Checks: `default` (batch asserter), `treefmt-tree-root`, `mdformat-plugins`, `agents-md-citations`,
    `root-surface`, `ci-plane-coverage`, `ci-self-input`, `tests-error` (declarers only).
  - Devshell commands: `ci` (suites, then builds every check but `tests-error`, naming each failure),
    `ci --tests-error`, `ci --tests-process`, `ci <suite>.<cell>`, `fmt`, `repl`, `relock`.
  - Hooks: `treefmt`, `ci`, `ci-error`. Test modules receive `name`, `genInputs`, `genPrelude`,
    `readRootsRel`, `readRootsDeclared`.

**Invariants and laws:**

- Every guard's predicate is an ABSENCE, so each is preceded by a positive control on the same artefact
  in the same run. Preserve that shape when editing any oracle.
- `readRoots` is CONCATENATED with `testModules`, never a default (a Nix default is replaced, dropping the
  collection root). The derived list is forced with `deepSeq` so a misspelt root throws.
- `projectRootFile = null` is load-bearing: otherwise treefmt walks for `.git`, which in a linked worktree
  is a pointer FILE, climbs out and formats the MAIN checkout while reporting success.
- The devshell unsets `core.hooksPath` on every entry: a relative hooks path in a linked worktree names
  nothing, and commits land ungated.
- The commit hook runs pre-commit on an EXPORT of the staged tree (`git write-tree`), never `exec`s
  pre-commit: its shim stashes the whole checkout and loses other writers' unstaged edits.
- `agents-md-citations` reads `inputs.self.sourceInfo.outPath`, never `outPath` (which is `<root>/ci`).
  It checks that a claim's EVIDENCE exists, never that the claim is true.

**Working in it / using it:**

- Local gate: `nix develop ./ci --command ci` AND `... ci --tests-error` (and `--tests-process` here).
  These are guarded: they refuse any git-unknown file under a read root. Fix with `git add` or a move.
- Unguarded: `nix flake check ./ci`, `nix-unit --flake ./ci#tests|#testsError` (git-filtered tree, so an
  untracked cell is silently absent).
- CI: a job `uses: <owner>/gen-harness/.github/workflows/evaluators.yml@<rev in ci/flake.lock>`; it runs
  the upstream Nix, Determinate and Lix columns. `relock` keeps that sha equal to the lock.
- Run one cell: `ci <suite>.<cell>` or `nix-unit --flake ./ci#testSingletons.<suite>.<cell>`.
- More prelude than `hasInfix`: declare gen-prelude at the library ROOT and pass `specialArgs.genPrelude`.
- Add an mdformat plugin: `gen.ci.mdformat.extraPlugins = p: [ ... ];`.
- Test a harness change against a consumer: write the lock with `nix flake lock ./ci --override-input gen-harness <ref>`. An in-memory `--override-input` is refused by `checks.tests-error`.

**Traps:**

- `nix flake check .` at the repo ROOT is green over ZERO gates (root only has `lib`). Use `./ci`.
- `nix flake check` does NOT run `testsError`. A cell that can abort placed in `tests` CRASHES the
  batch gate instead of failing it. The predicate is "can abort", not "expects an error".
- Targeting a cell by its natural attrpath (`./ci#tests.<suite>.<cell>`) prints `0/0 successful` at rc 0:
  a FALSE PASS. nix-unit finds tests by the `test` prefix of a group's children. Use `testSingletons`.
- `AGENTS.md` may be globally gitignored on a host: `git add -f AGENTS.md`, or the citation check reports
  "no non-empty AGENTS.md".
- `genPrelude` has exactly one attribute (`hasInfix`); anything else is `attribute missing`.
- `]` is not in the regex escape set by design; adding it ABORTS, and `tryEval` does not catch it.
- Writing `programs.mdformat.plugins` directly REPLACES the base plugins, silently. A plugin list put in
  treefmt's `package` is discarded outright, and the damage is idempotent, so format-and-compare stays green.
- The `ci-error` hook's enable test is per CELL (`any (s: s != { })`); a shallower test enables it on an
  empty suite and reads `0/0` at rc 0.
- The read-roots guard covers only the three wired points (`ci`, `ci-error`, the `ci` command).
- The harness tests itself with itself: if `mkCi` stops evaluating, the suite crashes instead of going red.
- `repl` is declared for every consumer but `ci/repl.nix` is not generated; each repo ships its own.
- The batch failure message runs only on failure, so a bug in it masks the red. Nix reports the abort at
  the lambda's birthplace, often another repo. `toJSON` aborts on functions, and `toPretty` overflows on
  real option types (cyclic through `functor.type`).
- A relock moves the member's own formatter and hook; `relock` reinstalls the hook and reformats source
  when a node moved, or the stale hook silently reverts what CI requires.
- `FLAKE_ROOT` is the directory the devshell was entered from. Run `nix develop ./ci -c relock` from the
  repo root, never `cd ci && ...`.
