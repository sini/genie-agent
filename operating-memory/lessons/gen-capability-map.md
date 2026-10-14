---
name: gen-capability-map
description: 'Before building any engine or mechanism in or on the gen ecosystem: which library owns which concern'
type: reference
---

**Rule:** Name the library that owns a concern before you build it or report it missing. Re-derive the roster from `gen/lib/mkGenLibs.nix` (hub-wired libraries, by stratum), because every written roster has gone stale. Per-library API detail lives in each library's own docs; this file gives roles only.

**Roles (durable; capabilities drift, so grep before asserting a gap):**

- **gen-resolve**: the stratified-fixpoint conductor, i.e. the convergence LOOP. About to build a "stratified fixpoint / resolution engine"? Extend this.
- **gen-dispatch**: the dispatch STEP (one stratum's rule evaluation). Loop ⊥ step.
- **gen-scope**: the demand-driven attribute-grammar evaluator ("Nix is the evaluator"). Owns edge DATA and evaluation.
- **gen-graph**: graph QUERIES: labeled regex traversal, reachability, fixpoints, transpose, condensation, pre-order folds. Owns closure and reachability.
- **gen-memo**: the incremental plane (decides REUSE, never evaluates), defined by byte parity against a cold run.
- **gen-algebra**: ordered-monoid layered folds with provenance, records, search monad.
- **gen-types** CHECKS. **gen-merge** MERGES (it reproduces `evalModules` byte-for-byte). A merge question belongs at gen-merge, not gen-types.
- **gen-schema**: typed registries, identity hashing, per-key `keySemantics`. **gen-aspects**: aspect types built generically from those semantics.
- **gen-pipe**: scoped channels whose combines are ORDER-BEARING monoids. Never make them commutative/idempotent.
- **gen-demand**: a spawning typed cascade. This is not gen-resolve's layer-folding `cascade`; same word, different thing.
- **gen-bind**: binding injection into module functions, plus the terminal-crossing arg environment.
- **gen-flake**: the single nixpkgs boundary. Compose purely, realize at a terminal, inject VALUES. Gen types never enter a consumer's options tree, and gen-merge and nixpkgs cannot both own the option declarations of one class body.
- **gen-assemble**: framework toolkit above the stack. It declares no inputs and is constructed inside the consumer's evaluation.
- **gen-program**: turns policy declarations into a program and calls the solver.
- Standalone (not hub-wired): gen-rebuild, gen-vars. Instruments: gen-differential, gen-harness.
- den is the first framework built ON gen. Users do not migrate from den to gen.

**Why:** Measured misses: concluding "no per-type merge" from gen-types (merge is gen-merge's job); proposing closure in gen-scope (gen-graph has it); an "absent" capability recorded on the same day the commit adding it landed.

Related: \[[reuse-before-building-an-engine]\] \[[library-ecosystem-conventions]\] \[[gen-primitive-contracts]\]
