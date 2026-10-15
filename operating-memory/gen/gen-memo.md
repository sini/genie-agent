---
name: gen-memo
description: Working in gen-memo, the incremental plane (reuse decisions, verifying traces, dirty cones, propagation, warm fold) over the gen evaluator.
type: reference
verified: unverified
---

**Purpose:** the INCREMENTAL PLANE, a decision layer over the evaluator that never evaluates and only
decides REUSE. Its definition is a byte-parity oracle against a cold evaluation: every plane output must
be byte-identical to a cold run. So the plane is correct exactly when it is invisible in the result and
visible only in the work avoided. In the Mokhov build-systems decomposition it is the REBUILDER half
only; the scheduler is Nix's own laziness.

**Depends on / used by:** root inputs gen-prelude and gen-graph only. The evaluator is a PARAMETER, never
an input. `ci/` pins gen-scope, because a fold handed an evaluator can only be tested by handing it a
real one (a stub would make the suite an oracle for the stub). Hub stratum: `substrate`. Consumers go
through the hub, not `inputs.gen-memo.lib` directly.

**Not its job:** evaluating anything (gen-scope, the sole evaluator; a caller-supplied `recompute` is
the shape); scheduling (Nix laziness); the static attribute schedule and the COLD fold (the query-gate
home and the evaluator); equation records with `stratum`/`readsAttrs` (not migrated: reuse is decided from
the evaluator's own resolutional vocabulary); graph traversal, cones and SCC partition as ALGORITHMS
(gen-graph: consume `dependentsOf`, `reachableFrom`, `coneRank`, `condensation`, never mirror them);
well-definedness checks (graph-native analysis queries); the demand cascade (gen-scope); settings
folds (gen-settings). The plane's whole risk is re-implementing something one row below it.

**The interface to the evaluator:** the plane returns a `Decision` of two total functions and no
values, reads through a restricted facade of exactly `get` / `nodeIds` / `resolutional`, and never
receives a structural value from a prior evaluation.

**Layout:** `lib/build.nix` (store + verifying trace), `drivers.nix` (change/propagate split, `override`),
`eager.nix`, `structural.nix` (topology deltas), `affectedSet.nix`, `restabilize.nix` (per-SCC solver,
`runScc`), `provenance.nix`, `hash.nix` and `merge.nix` (internal, not exported),
`reference/schedule.nix` (reference scheduler, deliberately OUTSIDE `lib/`), `examples/dag`.
Root `default.nix` is a function of `{ prelude, graph }`.

**API (31 exports; `ci/tests/surface.nix` pins them exactly):**

- Build and reuse: `build { fixpoint ? null; } engine { accessor; recompute; hashOf; }`, `needsEval`,
  `earlyCutoff`, `verify`. These three decide at DIFFERENT times (before recompute, after recompute,
  against the stored trace). Never collapse them into one.
- Cones: `affected`, `impactOf`, `dirtySet`, `affectedSet` (exact set, post-filtered from the cheap cone).
- Change/propagate: `applyDelta`, `batch`, `propagate`, `override engine ctx id newDecls` (fused,
  data-change only), `force`, `forceCtx`, `propagateEager` (opt-in, for localized cut-heavy edits).
- Topology: `mkAccessor`, `retract`, `applyEdgeDelta`.
- Cycles/provenance: `runScc`, `restabilize`, `support`, `supportDirect`, `why`, `whyNot` (total over
  all three verdicts), `whyFor`, `whyNotFor`.
- Warm fold: `warmDecision`, `warmOverride`, `warmResolve`. Observation: `warmAdmits` (the reuse key is a
  required PARAMETER: the plane holds no evaluator's argument names), `warmTrace`.
- Twelve exports take the ENGINE FIRST because they reach a store: `build affectedSet propagate override force forceCtx retract applyEdgeDelta warmOverride warmResolve restabilize propagateEager`.

**Invariants and laws:**

- A plane that accumulates its own evaluation state has failed. Any "cache" not defined by the
  byte-parity oracle is that failure.
- The plane binds no store fix. Every former `prelude.fix` store knot now calls
  `engine.schedule { accessor; domain; base; recompute; isClean; }`: the plane supplies the decision, the
  engine binds the knot. Cells: `test-plane-binds-no-store-fix` (zero `prelude.fix` in `lib/`, with the
  reference scheduler as live control) and `test-plane-does-not-import-the-reference-scheduler`, because
  importing the scheduler brings the knot back with no `fix` token at all (measured by planting it).
- The engine is supplied at every call and stored in no returned record.
- One known residue: `runScc`'s accumulator in `restabilize.nix` (Kleene ascent). A cell counts such sites
  at SITE granularity, so a new one reds even in an already-listed file.
- Name collisions in the module fold are REFUSED, never resolved by list order. Renames must not read as
  synonyms (`warmOverride`, `warmTrace`).
- Hash helpers stay internal: the evaluator is owed no hash surface.
- Changing the surface means updating `lib/`, `ci/tests/surface.nix`, this sheet and the external reference
  spec in one change. The surface test fails until you do.
- Claims the library makes in its own voice: a flat, relocatable store; the reverse-topological splice;
  "eager push". RTD's true O(|AFFECTED|) optimality is NOT reached in pure evaluation.

**Working in it:** `nix develop ./ci --command ci` (guarded; `ci purity` runs one suite);
`nix flake check ./ci` is what CI runs (unguarded). REPL: `nix repl --impure --file ci/repl.nix`.
Format: `cd ci && nix fmt -- --ci`. Demo: `nix eval -f examples/dag`. The root flake has no inputs and
so no root lock; `ci/flake.lock` is the only lock. The shim resolves defaults by walking `follows`,
because a lock node key (`gen-prelude_4`) can differ from its label.

**Traps:**

- A derivation is self-referential: the admission projection must recognise the derivation shape at every
  position BEFORE descending, keyed by `__drvPath`. Never remove that short-circuit.
- gen-graph's `condensation` returns MAPS: `cond.members tag` fails "attempt to call something which is
  not a function but a set" at runtime.
- nix-unit collects only `test-*` cells; a cell losing its prefix vanishes and the run stays green.
  `nix flake check`'s asserter backstops it.
- An untracked file under `ci/tests/` is invisible to the flake, even a deliberately failing one.
- `nix-unit` `expectedError` is unassertable in `checks.default`; a guard whose firing cannot be observed
  does not belong in this suite.
- Purity scan labels must be repo-root-relative, or `lib/default.nix` and root `default.nix` collide.
- `AGENTS.md`/`.envrc` may hit a global gitignore: first add needs `git add -f`. Confirm ignore rules with
  `git check-ignore -v --no-index` (without `--no-index` it skips tracked paths). A cross-repo "ships this
  file" sweep asks `git ls-files`, never `test -e`.
- Reconcile declared vs collected cells BOTH directions:
  `grep -rhoE '\btest-[A-Za-z0-9-]+' ci/tests/ | sort -u` against nix-unit's output, then `comm -23` and
  `comm -13`. The class MUST include capitals (`test-whyNot-...`): a lower-case-only class truncated names,
  inventing 12 mismatches and hiding 51.
- Drift check uses the flake-ref form `nix eval --json .#lib --apply builtins.attrNames`; `--expr 'import ./lib'`
  fails in pure mode.
- `ci/repl.nix` must ship: the shared devshell's `repl` command points at it.
- `nix fmt` from a linked worktree can format the main checkout; the harness sets `projectRootFile = null`.
