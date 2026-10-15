---
name: gen-scope
description: Working in gen-scope, the sole evaluator (demand-driven HOAG over scope graphs) plus the well-founded logic engine, staged minting and the demand cascade.
type: reference
---

**Purpose:** gen's sole evaluator: a demand-driven higher-order attribute-grammar evaluator over algebraic
scope graphs. You supply root node descriptors (`{ id; type; parent; decls; }`) and attribute definitions
(`self: id: value`); `eval` returns an accessor record whose attributes compute lazily and memoize on an
`_eval` cache co-located on each node. (The same repository was once named scope-engine.)

**Three further, independent concerns live here.** Route a task by its nouns:

- atoms, rules, negation, a fixpoint over a policy program: the **well-founded engine** (`mkProgram` in,
  a three-valued model out, `UNDEFINED` a named verdict);
- nodes, attributes, scopes: the **evaluator**;
- emitters, passes, relata, identifiers: **staged minting** (`mintStrata`: emitters in, a scope graph out);
- claims, kinds, resolvers, resources, wiring: the **demand cascade** (`resolveClaims`).
  "Strata" alone does **not** route: it means a rule layer, a declared pass, or a kind depth respectively.
  The only shared module is `lib/least-model.nix` (`forceFields`).

**Depends on:** gen-prelude, gen-graph (condensation, endpoint projection, `mkDeclaredEdges`),
gen-identity (`hashIdentity`, injected; never re-exported). Not gen-schema, not gen-select.
**Used by:** gen-program (engine), gen-memo (warm reuse), gen-view (resolution authority), gen-resolve's
equations (`foldEquations`), the hub, gen-demo.
**Not its job:** static read-dependency schedules (gen-resolve's builder), SCC algorithms (gen-graph),
selectors, registries and `id_hash` (gen-schema), dirty-set computation (gen-memo), settings precedence.

## API (101 exports, flat; `wfl` is the one namespace)

- Graph construction (Mokhov): `empty vertex vertices overlay overlays connect edge edges path circuit star clique tree forest gmap induce transpose hasVertex hasEdge removeVertex removeEdge`.
- `buildRoots { parentGraph; importGraph; edgeGraphs; decls; types; kinds; strict ? true; }` ->
  `{ nodes; nodeOrder; kinds; }` (`buildNodes` is a tombstone). `P` and `I` labels are reserved.
- Evaluators: `eval { parseParent; prior; decision; provenance; declaredDependencies; } attributes scope`
  (an options door: unknown keys refused by name); `evalDebug` (cycle tracing, defeats memoization);
  `evalWarm { … } { scope; attributes; prior; decision; }`.
- Accessor record: `node`, `get` (tier 1); `allNodes`, `allNodeIds`, `allNodesWhere`, `subtreeOf`,
  `nodesOfType` (tier 2, force the tree); plane interface `facade`, `resolutional`, `served`,
  `structuralEdges`, `decisionFindings`, `projectionFindings`.
- Plane interface: `structural name` (total partition), `resolutionalNames`, `edgePrefix` (`"edges-"`),
  `coldDecision`, `mkDecision { isClean; reusable; }`, `mkFacade`.
- Combinators (`self: id: value`): `shadow`, `inherit'`, `inheritAll`, `inheritSet`, `circular { carrier = { bottom; leq; height; quotient; }; } step`, `collectionAttr { } traverse extract`, `collectImports`,
  `collect`/`collectByType` (no `id` argument), `followEdge`, `collectByLabel`, `subtypeOf`. Queries
  (`self` first): `parent children childrenIds ancestors descendants siblings isAncestor isDescendant nodesByType`.
- Resolution calculus: `resolve { wf; dataFilter; mode ? "reachable"; order; group | groupBy; bound; direction ? "outbound"; } self from`; `wellFormed`, `labelOrder`, preset `neron` (`parent* imports?`,
  D < I < P). Modes: `reachable`, `witnesses`, `visible` (with `shadowed`, `single`).
- Engine: `mkRule { pos; neg; } head`, `mkProgram rules`, `leastModel seed program` (routes via `armFor`
  to `leastModelUnary`/`leastModelRounds`), `reduct`, `wellFoundedModel interpretation program`,
  `verdictNames`, `Pos`, `solve interpretation program` (adds `condensationDepth`, `provenance`),
  `foldContributions`, `verifiedDepth`, `acceptanceSignal`.
- Minting: `mintStrata kinds emitters -> { nodes; edges; strata; unrun; sites; }`, `argumentBinding`.
- Cascade: `mkKind { below; resolve; spawns; nta; dedupKey; fold; kindValue; } name`, `mkKinds`
  (ordered fold), `mkClaim`, `resolveClaims { ctx ? {}; } kinds claims -> { resources; wiring; unrun; trace; }`; `folds.{ same one list mergeAttrs byKey }` (signature `key: [v]: v`).
- `stratify { schedule; stratumOf; within; seed; advance; describe; }`; `foldEquations { settings ? {}; } { scope; parseParent; schedule; declaredDependencies; }` -> an 11-field sealed context.

## Invariants

- **The body is the read set.** There is no `readsAttrs`. Reads derive from the graph. `declaredDependencies`
  is required and total (absence is refused, never "depends on nothing"); its codomain is checked at
  construction, but its **coverage** is not: a body may `self.get` an undeclared real dependency.
- Structural attributes (`children`, `derived-children`, `edges-*`, `imports`, `includes`, `marks`) are
  **always recomputed**, never served warm. The worst a buggy `reusable` decision does is miss a reuse; a
  wrong `isClean` serves stale values, and byte-parity against a cold run is the only instrument for that.
- Growth has one channel: `spawns` on the host kind. `children` only *selects* among the scope's nodes.
- Engine: `verdict` is total (unmentioned atoms are `"false"`); atom lists come back in declaration order.
  Stable-model existence is **not** decided here. `solve` never partitions itself (gen-graph does).
- Minting: a relatum must be minted in a **strictly earlier** pass, so cycles are inexpressible, not
  detected. The frozen set is built internally (a caller-supplied one would be forgeable).
- Cascade: kinds are minted by an ordered fold, so a cyclic `below` cannot be minted. The schedule is the
  depth measure descending, a theorem-bounded loop with no convergence test or cap. A resolver sees only its
  claim and a constant `ctx`, so no answer can depend on where in a stratum it ran. The answer's key set is
  **closed** (`resources wiring claims`); a payload's is open. `unrun` is returned, never thrown.
- Round loops are iterative and force every accumulator field per round (deep recursion past the call-depth
  guard aborts uncatchably).
- `lib/default.nix` is a literal surface; a refusing merge in the suite throws on any name contributed
  twice. nixpkgs-lib-free (purity test).

## Working in it

```sh
nix develop ./ci --command ci
nix develop ./ci --command ci --tests-error
nix develop ./ci --command ci --tests-process   # per-process cells, under the nix on PATH
nix flake check ./ci                            # what CI runs; unguarded
```

Benches live in `ci/bench/` (parent-chain linearity, `dataFilter` call counts, visible fan-out).

## Traps

- `children`/`derived-children`/`imports`/`edges-<l>`/`marks` are reserved names nothing supplies: declare
  them in `attributes`. A materialization without `children` refuses by name (it used to return a silent
  partial tree). `self.get id "children"` excludes `derived-children`.
- `followEdge "X"` reads a computed attribute `edges-X`; `buildRoots` only writes `decls.__edges.X`.
- `star` runs leaves to center (inverted relative to Mokhov), matching child-to-parent `P`.
- `subtypeOf`'s default `eq` compares nothing; a value-comparing `eq` drags in the synthetic `__edges`.
- `allNodes` loses walk order (attrset); use `allNodeIds`. Root ties break by **bytewise codepoint**, and
  `derived-children` interleave with `children`. A flat fixture cannot tell the two orders apart.
- The import relation is protected by its **name**: a renamed import attribute is served stale.
- `circular` refuses three causes separately (bad declaration, non-ascending step, height exceeded).
- `resolve` here is the Néron specificity function, unrelated to the gen-resolve library.
- A rule with two literals can be **unary**: routing uses the greatest positive body arity.
- `tryEval` discards a throw's message, so refusal text is unreadable in-language.
- **Two abort signatures:** an unforced accumulator chaining through function application exhausts
  `max-call-depth`; through a bare `+` it overflows the C stack. A sweep armed for one reads the other as
  green. A strict read forces only the field it reads.
- Cascade `wiring` is total: test key membership, then read. A bare `wiring.<id>.entries` aborts
  uncatchably on an unregistered subject; `(wiring.<id> or { entries = []; })` erases the difference.
- A resolver returning a list, number or `null` used to contribute nothing silently; the answer is now
  shape-checked. Keep a `{ }` live control for the legitimate empty answer.
- `folds.same` refuses functions and paths before comparing (`==` is not reflexive on bare functions, and
  `toJSON` on a path aborts or copies it into the store).
- Mint: a same-run relatum at the same pass refuses with a message that reads like a typo. Reading one
  result field runs the whole mint. `strata` counts distinct passes.
- `stratify` throws nowhere; a list field is forced to its spine only, so `settled = [ (throw …) ]` may
  never fire.
- Do not cite a paper you do not hold as the source of a construction; mark the attribution unchecked.
