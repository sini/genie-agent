---
name: gen-merge
description: Working in gen-merge, the pure-Nix byte-mode module merge engine (evalModuleTree) that reproduces lib.evalModules output with zero nixpkgs.
type: reference
verified: unverified
---

**Purpose:** the module MERGE engine. `evalModuleTree` collects a module tree, ties one local `config`
fixpoint, resolves per-option definitions by priority, dispatches structural types to their `.merge`,
routes undeclared keys through a `freeformType`, and verifies leaves through injected gen-types
checkers. It reproduces the OUTPUT of `lib.evalModules` plus `lib.types` merging with zero nixpkgs.
"Byte mode" means: reproduce nixpkgs' order-sensitive merge as the conformance oracle; it does NOT
implement a confluent semilattice merge or pre-eval identity dedup.

**Depends on / used by:** `lib/default.nix` takes `{ prelude, types, memo, scope }`, all four
REQUIRED (gen-prelude, gen-types, gen-memo, gen-scope). gen-scope is the ONE evaluator: the module tree
is a node on it, and the `config` knot is an ordinary attribute. It is bound at library construction
because that is the only channel into nested structural folds. Consumers: gen-schema, gen-aspects,
gen-class (injected as `merge`), the hub. Not its job: type checking (gen-types), kinds and registries
(gen-schema), cross-node scheduling (gen-scope), change propagation (gen-memo decides reuse; gen-merge
only computes the contribution FACT), flake composition (the hub's `lib.compose`).

**Layout (`lib/`):** `modules.nix` (the engine, warm path, provenance, `undeclared`, `deprecations`),
`types.nix` (strategies; `defineType` is the ONE crossing site), `interface.nix` (the nixpkgs
`optionType` protocol boundary: `exportType`/`importType`/`exportFields`), `priority.nix`, `lint.nix`,
`types-allowlist.nix`. Tests: `ci/tests/`, `ci/tests-error.nix`, `ci/tests-process.nix`,
`ci/modules-sh-ratchet.sh`.

**API:**

- `evalModuleTree { specialArgs ? {}; check ? null; prefix ? []; coreShortCircuit ? false; warmFrom ? null; editedModules ? []; } modules`. Options are closed and come FIRST; a one-record call is refused by name.
  Result: `{ config; options; provenance; undeclared; deprecations; type; freeformConfig; freeformProv; warmDecision; }`.
- `declaredOptions` (declaration fold only), `mergeDefs loc type defs`, `mergeDefsPartial`,
  `partialAttrsOf`, `partialSubmodule`, `mergeOneOption`, `showOption`,
  `mergeTypes a b` (positional: asked of the FIRST operand), `deriveType`, `bandedLeaves`.
- Priority: `mkOverride n`, `mkOptionDefault` 1500, `mkDefault` 1000, bare def 100, `mkForce` 50; `mkMerge`, `mkIf`.
- `mkOption`, `mkOptionType` (completed to the 14-field nixpkgs protocol). Strategies: `submodule`, `listOf`,
  `attrsOf`, `lazyAttrsOf`, `deferredModule`, `nullOr`/`option`, `either`, `oneOf`, `raw`, `anything`.
- `types` = gen-types leaves UNION gen-merge strategies (strategies win on `attrs attrsOf listOf option`).
- Knob markers: `mkCoreValue digest values` (only under `coreShortCircuit = true`), `pureModule fn`.
- `lint modules -> [ { kind; loc; file; detail; } ]`. The kinds are `order-pass`, `options-introspection`,
  `type-merge`, `function-to`, `unverifiable`. An empty list means the modules are portable.
- Provenance per loc: `{ defs = [{ file; priority; }]; winners; priority; defaulted; }`.
- Warm re-eval after an APPENDED edit: `evalModuleTree { warmFrom = prev; editedModules = edited; } (base ++ edited)`.

**Invariants and laws:**

- Every record-taking step is a `prelude.door`: unknown options are refused by name, catchably, with the
  contract published as data (`__contract`).
- One override rule: the lowest priority number wins, and ties merge. nixpkgs' order pass is DROPPED.
- One crossing site to the foreign protocol (`defineType`), so one type value serves both engines. A gen
  type states itself in gen's own words (`verify`, `admits`, `typeMergeRel`, `carries`) and gets nixpkgs
  field names only when exported.
- A redeclared option is decided by the TYPE ALGEBRA, never by position. A non-merging pair is a named
  refusal listing every declaring file.
- A container is recognised by its fold and what it CARRIES, never by its name.
- Nested trees are children of ONE `scope.eval`. The called fold of a nesting type refuses by name; the
  exported `merge`/`emptyValue` bridge with one standalone evaluation per tree.
- Reports go on result SIBLINGS (`undeclared`, `deprecations`), never stderr: the eval cache swallows
  `trace`/`warn`, so a printed report appears once and never again.
- gen-merge computes the contribution FACT for warm reuse; gen-memo DECIDES reuse.
- Rows in the traps table are either a STANDING boundary (a deliberate divergence) or REMEDIATED (a
  defect now fixed). Never let a defect sit as an unmarked trap.
- Cite into `lib/` by SYMBOL, never by line range: a drifted range fails plausibly, while a stale symbol
  fails loudly.
- A single-caller helper lives in a `let` over its caller's lambda (file-level bindings cost a thunk per load).
- `lib/` is nixpkgs-free (purity cell); `ci/` uses nixpkgs as the equivalence oracle's reference side.

**Working in it:** `nix develop ./ci --command ci`, `... ci --tests-error`, `... ci --tests-process`
(per-process cells), `bash ci/modules-sh-ratchet.sh`; CI runs `nix flake check ./ci` then `nix fmt -- --ci`.
The `types` half of the drift check moves with the locked gen-types, with no gen-merge commit.

**Traps (standing boundaries):**

- Definition order is REVERSE module order, but `mergeDefs` consumes YOUR list order unchanged.
- `raw` collapses EQUAL multiple defs instead of refusing; use `mergeOneOption` for the strict rule.
- `mkOrder`/`mkBefore`/`mkAfter` markers pass through as ordinary values. `lint` reports `order-pass`.
- `functionTo` does not exist; `lint` flags `function-to`.
- `attrsOf` and `lazyAttrsOf` never merge with each other; same-name containers merge only if their elements do.
- A nested tree surfaces `.config` only; its inner provenance is not threaded out.
- `.options` is a bare descriptor map, not nixpkgs' options structure (no `loc`, `declarations`, `isDefined`).
- `.config` is `_module`-free even when a module sets `_module.args`.
- An undefined option errors only when its type has no `emptyValue` (`attrsOf` gives `{}`, `str` throws).
- `deferredModule.check` rejects an absolute-path string (stricter than nixpkgs).
- EVERY function module is classified dirty for warm reuse unless wrapped in `pureModule`.
- Reading provenance forces that loc's defs to WHNF; a `throw` def fires on a `.defs` length read.
- Freeform provenance reports `winners`/`priority`/`defaulted` as `null`, meaning "not observable".
- `mkCoreValue` with the knob OFF is an ordinary attrset and leaks its keys into the value.
- Core-seam predicates (`mergeOption`, `classifyModule`, ...) are not on `.lib`; CI imports the file directly.
- `oneOf []` throws at construction; `submodule` binds `name` per key.
- The warm identity refusal sees only instances at positions whose declared type carries identity;
  identities in `raw`/`anything`/freeform slots are untracked.
- On a container node, `result` is `{ value; _nested; }`; reading `.config` there is an uncatchable missing
  attribute. Check the host position's `mode` first.
- The import walk is bounded by `importedTypeWalkFuel` (32) and refuses a self-referential element by name.
  The remedies: wrap it in a recognised container, declare no gen nesting element, or set
  `declaresNesting = false` (which silently evaluates any forwarded tree standalone).
- Enumerating a deep node set grows exponentially with nesting depth; read values through the fold.
