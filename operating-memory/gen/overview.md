---
name: gen-overview
description: Start here before working in any gen library — the framework's purpose, the roster, the layering and the conventions every member shares.
type: reference
verified: unverified
---

**Purpose:** gen is an ecosystem of small, independently versioned, pure-Nix libraries for
building demand-driven, graph-structured configuration frameworks. The end state is a pure
graph-based configuration framework: every aspect is a node, every system and user is an entity
node, every relation is an edge that can be queried, and policies are logic programs producing
dynamic edges on one execution layer. A configuration framework (den, for NixOS / nix-darwin /
home-manager) is then built on top. No gen library knows what NixOS is.

Each library owns exactly ONE concern, is named after the literature it comes from, ships its own
test suite and CI gate, and talks to siblings only through accessor functions and plain attrsets.
Take only what you need: `inputs.gen-graph.lib` works without the hub.

## Roster (roster key → repo — what it owns)

Substrate (`gen.lib.substrate`):

- `prelude` → gen-prelude — zero-input vendored pure utilities (nixpkgs.lib-free) and `refusals`, the refusal texts as renderers.
- `algebra` → gen-algebra — records (Leijen/Bracha scoped labels), Either, intensional-function encoders over an injected mint.
- `identity` → gen-identity — the one identity mint: kind-tagged hash over a bounded canonical encoding.
- `schema` → gen-schema — typed record registries: kinds, instances with content-addressed `id_hash`.
- `scope` → gen-scope — the sole evaluator: demand-driven higher-order attribute grammar over scope graphs.
- `graph` → gen-graph — accessor-based graph queries (reachability, SCC, phase order, label regex).
- `select` → gen-select — selector algebra over attributed graph positions.
- `bind` → gen-bind — partial application of external bindings into module functions.
- `dispatch` → gen-dispatch — one relational guard→effect dispatch STEP over ordered groups.
- `product` → gen-product — graph products (Cartesian, tensor, strong, lexicographic) as lazy operations.
- `memo` → gen-memo — the incremental plane: decides reuse, never evaluates; byte-parity with a cold run.
- `view` → gen-view — derived-view constructor, the `(L, E, <, k)` carrier and named compositions.

Modules (`gen.lib.modules`):

- `types` → gen-types — the checking half: `verify` returns `null` or an error string.
- `merge` → gen-merge — the merging half: `evalModuleTree`, reproducing `lib.evalModules` output with no nixpkgs.

Aspects (`gen.lib.aspects`):

- `aspects` → gen-aspects — aspect composition types, path-derived identity, declared-key classification.
- `class` → gen-class — class-share: partition nodes, compute a byte-identical shared core, apply, gate by sha256.
- `link` → gen-link — cross-flake aspect federation over origin-labelled subgraphs.

Framework (`gen.lib.framework`, above the stack):

- `assemble` → gen-assemble — the contribution protocol, its union, the id convention, shared framework boilerplate.
- `delivery` → gen-delivery — discovers declared delivery classes per node and folds each class to its terminal.
- `inspect` → gen-inspect — interrogates a materialized graph: nodes, edges, rule provenance, `why`, mermaid.
- `program` → gen-program — policies as logic programs over gen-scope's well-founded engine (three-valued).
- `rules` → gen-rules — the one closure door: lowers closures to first-order door nodes/rules; rule-pattern catalogue.
- `settings` → gen-settings — stratified settings resolution with provenance (experimental).

Off-roster: gen-harness (the CI harness, `mkCi`, pins no gen library), gen-vars (variable
generation), gen-demo (the integration corpus that exercises every landed component).
Retired and archived for reference (bind the destination, never these; full map in \[[gen-retired]\]): gen-demand → gen-scope;
gen-edge and gen-pipe → gen-view (and gen-select); gen-flake → the hub's `flakeModules.default`,
gen-memo, gen-delivery; gen-resolve → gen-scope (cold fold, `foldEquations`) and gen-memo (warm fold).
One export has no destination yet: gen-resolve's `_scheduleWith` is still the sole producer of the
schedule `foldEquations` takes, so a caller of the cold fold still reads it from the archived repository.

## Layering

Strata, ordered `substrate < modules < aspects < framework`. A dependency edge may only point DOWN
the chain; the hub's CI refuses an upward edge by name. The stratum map is a total, explicit
declaration (`strata`): a member with no entry is a build error, never a default bucket. A fifth
value, `retiring`, publishes no path, so nobody newly adopts a library that is leaving.

Dependency classes: **A** zero inputs, **B** gen-prelude only, **C** nixpkgs-lib, **D** nixpkgs-lib
plus gen. C and D are empty on the roster. The graph is acyclic and shallow:

```
prelude, algebra, select       zero inputs
types ← prelude                merge ← prelude, types
schema ← prelude, types, merge, algebra
aspects ← prelude, merge, schema
scope, graph, bind, dispatch, product, class ← prelude
settings ← prelude, algebra, bind, graph
link ← prelude, scope, view, schema, algebra, aspects
```

Two planes, one crossing: the composition plane is pure and nixpkgs-free; the terminal plane is
nixpkgs (gen-delivery's `realize` hands content to per-class terminals; the default `nixos` terminal
comes from the hub's interim `flakeModules.default`). **Gen types never leave the pure eval; only
values cross.** A gen type may ride along as inert data, never into the consumer's options tree.

## Cross-library conventions

- **One concern, one `.lib`.** Every library exports exactly one `lib`; each resolves its own
  dependencies (self-wiring), so a consumer wires nothing.
- **Never reach through a sibling.** A library does not import another's flake inputs to read its
  data; it accepts the sibling's result shape through an adapter or accessor.
- **Accessors, not data.** Graphs arrive as functions (`edges = id: [...]`), never materialized maps.
- **Actions are opaque.** Libraries provide machinery; consumers provide meaning.
- **Step, loop and ordering are separate.** dispatch is a step, gen-graph's `phaseOrder` is the
  order, the fixpoint loop lives in the evaluator.
- **nixpkgs-lib-free.** A per-repo purity scanner (`ci/tests/purity.nix`) refuses nixpkgs use.
  Where `lib.*` alone is needed in CI, pin `nixpkgs.lib`, not full nixpkgs.
- **Capability sheet.** Every repo has an `AGENTS.md` with Scope, "Not this library's job" (names
  the owning sibling, quoting its `flake.nix` description verbatim), Exports, Entry points, Measured
  traps (with evidence), Theory, and a Drift check (command plus its verbatim output).
- **Reference-grade libraries.** Deleting an export needs a domain argument (wrong abstraction,
  subsumed, theory-unsound); "nobody uses it" is not a ground.
- **Names answer to the literature.** Cite the paper at the point of use; `TERMINOLOGY.md` in the
  hub is the provenance authority.
- **Refuse by name, never forge.** A construct that cannot do its job throws a named refusal; it
  does not substitute a default or a shape guess.
- **Three evaluators.** Every oracle runs under Nix, Determinate Nix and Lix in CI.

## Working in any member

- CI flake: `ci/flake.nix` calls `gen-harness.lib.mkCi { inherit inputs; name = "gen-<x>"; testModules = ./tests; }`.
  `ci/tests/` is `import-tree`d: a new test file is a gate the moment it lands.
- Local gate: `nix develop ./ci --command ci` AND `nix develop ./ci --command ci --tests-error` (if
  the member declares an error plane). These refuse on any untracked file under a read root.
  Bare `nix flake check ./ci` and bare `nix-unit` read a git-filtered tree and silently skip an
  untracked cell — `git add` new files before trusting a green.
- `nix flake check` stops at the first failing check; enumerate failures with
  `nix-unit --flake ./ci#tests`.
- Format before committing: `nix fmt` in `ci/`.
- Rebase, never merge. Read the CI run after every push.

Related: \[[gen]\] \[[gen-algebra]\] \[[gen-aspects]\] \[[gen-bind]\] \[[gen-dispatch]\]
