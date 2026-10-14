---
name: gen-graph
description: Working in gen-graph, accessor-based graph query combinators (reachability, SCC condensation, topological/phase order, edge-map algebra, pre-order folds).
type: reference
---

**Purpose:** pure graph algorithms over a graph the CALLER supplies as plain functions. gen-graph
never stores a graph. It answers reachability, SCC condensation, phase order, edge-map algebra and
pre-order folds. In the graph framework it is the query layer under every edge relation.
Reference-grade: deletion needs a domain argument, never a usage count.

**Depends on / used by:** only gen-prelude (`lib/traverse.nix` needs not even that). Used by gen-scope,
gen-memo, gen-view, gen-inspect, the hub.

**Not its job:** building the data (gen-scope); predicates over positions (gen-select; gen-graph takes
bare Nix predicates); choosing a rule winner (gen-dispatch; ordering moved HERE); graph products
(gen-product); minting ids (gen-schema / gen-identity); incremental rebuild (gen-memo); content
movement and channels (gen-view; gen-edge and gen-pipe are retired, do not route work there);
labeled resolution (gen-scope `resolve`).

**Accessor contract:** `edges : id -> [id]` (`u -> v` means u DEPENDS ON v), `nodes : [id]`,
`parent : id -> id|null`, `nodeData : id -> attrset`. Labeled: `labeledEdges : id -> [{ label; target; }]`
beside `nodes`. Edge map: `{ <from> = [to]; }`. Ids may carry string context; maps key by text.

**Layout and API (`lib/`):**

- `traverse.nix` (lazy, `genericClosure`): `reachableFrom`, `reachableWhere`, `canReach`, `selfReachable`,
  `ancestorsOf`, `pathsBetween { edges, maxDepth ? 2000 }`.
- `global.nix`: `cycles`, `cyclePaths` (ordered witness cycles; use for diagnostics), `dependents`
  (many targets), `dependentsOf`/`impactOf` (one target), `dependentsFrontier`, `directDependents(Of)`,
  `transpose` (keeps `parent`/`nodeData`), `coScc`, `condensationClosure`.
- `partition.nix`: `condensation` (front door, default arm `lowlink` = iterated Tarjan, no recursion)
  returning `{ reps; bottomUp; members; sccs; sccOf; condEdges; depth; }` (lookups are MAPS);
  named arms `fbNode`, `fbWork`, `lowlink`; finisher `condensationOf`; `cyclicEdgesWhere`.
- `order.nix`: `topoOrder { keyOf ?, lessThan ? } graph -> { ok = true; order; } | { ok = false; cycles; }`
  (options FIRST; a one-record call is refused by name). `topoOrderKahn` = the Kahn arm by name.
  `coneRank`, `phaseOrder` with `entryAnywhere/After/Before/Between`.
- `fixpoint.nix`: `fixpoint`, `seededFixpoint` (semi-naive), `compose`, `closureOf`, `closureClass`,
  `transitiveClosure`, `transitiveReduction` (DAG only).
- `edge-maps.nix`: `materialize`, `materializeParents`, `union/intersect/differenceEdges`, `selectEdges`,
  `forgetLabels` (the ONE bridge from labeled to global surfaces), `labeledTranspose` (keeps labels).
- `enumerate.nix`: `roots`, `leaves`, `select`. `preorder.nix`: `foldPreorder`, `expandPreorder`, `foldReach`.
- `registry.nix`: `fromRegistry`, `field(s)`, `mkGraph { edges = [{from;to;}]; parents; nodeData; }`,
  `fromScan` (derive edges from references found in values), public `fixtures`/`labeledFixtures`.
- `endpoints.nix`: `mkEndpointProjection`, `mkProjectionFindings` (same tests as a value; assert on it).
- Root `default.nix` is a function, `import ./gen-graph { }`, formal `prelude`; no `...`.

**Invariants and laws:**

- One edge direction everywhere. `phaseOrder`'s `before = [t]` on `n` becomes `t -> n`; authoring trap only.
- `reachableFrom` = R\*(start) minus start, even in a cycle; the reflexive bit is `selfReachable`'s.
- Edge maps are RELATION-PURE: all set ops drop empty rows; domain membership belongs to `nodes`.
- Refuse BY NAME and catchably. Validate in a staged order (isList, then isString per element, then
  membership): interpolating a non-string offender is an uncatchable coercion abort.
- No recursion proportional to n: loops are `genericClosure`/bounded iteration, so no node count hits
  `max-call-depth`. A step that recursed per node aborted uncatchably around 10^4.
- `lessThan` must be a strict total order on distinct keys (precondition, not checked: checking is O(m^2)).
- No nixpkgs `lib` (purity cell over `lib/**`, root `flake.nix`, `default.nix`).
- Theory: Tarjan 1972 (SCC, lowlink arm), Kahn 1962 (ordering), Datafun Lemma 4 only (fixpoint ascent),
  Bentley & Saxe 1980 (log-method visited set), Mokhov 2017 informed (transpose, quotient).

**Working in it:**

- `nix develop ./ci --command ci` and `nix develop ./ci --command ci --tests-error` (guarded). Unguarded:
  `nix flake check ./ci` (covers `#tests` ONLY), `nix-unit --flake ./ci#tests`, `nix-unit --flake ./ci#testsError`.
- An `expectedError` cell in `#tests` CRASHES `checks.default`; refusal cells go in `ci/tests-error.nix`.
- Cost claims come from `ci/bench/cost-classes.nix` under `NIX_SHOW_STATS`; quote a `sets.elements` figure
  only with `./ci/bench/sentinel.sh` reporting STABLE beside it.
- Drift: `nix eval --json .#lib --apply builtins.attrNames`.

**Traps:**

- `topoOrder` never throws on a cycle: read `.ok` first; `.order` is absent on the cyclic arm.
- Most ordering fixtures cannot see a wrong ready set (chain, total order, `wide`, binary tree all pass a
  comparator-blind arm). Assert order element-wise on a discriminating shape; `first|last|length` and cost
  figures are not ordering oracles.
- A cost bench whose shapes are all cyclic runs the emission loop zero times. Check `initialReady` > 0.
- Dense graphs (`total` shape, n(n-1)/2 edges) stay at Theta(E); improvements elsewhere do not help them.
- `phaseOrder`: an unknown name in `after` is refused, an unknown name in `before` is SILENTLY dropped.
  It throws on cycles and on self-loops.
- `mkGraph`'s `parents` create no `edges`. `fromScan` items are not node seeds (an unreferenced item with an
  empty scan is absent); `derivedEdges` keep parallel refs that `edges` collapses.
- `roots` and `leaves` are both empty on a fully cyclic graph; empty does not mean "no such node".
- `materialize` keys only on `nodes`; off-graph targets appear only as values.
- `fixpoint` guards subset order of edge content and throws at `maxIter` rather than returning partial.
  `seededFixpoint`'s check is ONE-STEP SUPPORT, not monotonicity: no refusal does not prove `step` monotone.
- `transitiveReduction` on a cycle returns the input unchanged, silently.
- `foldPreorder` does not cycle-guard frames whose `key` is `null`.
- `dependentsFrontier` includes a pruned node but does not expand it.
- `condensation.sccOf` is a map: an unknown id is a missing attribute.
- `impactOf == dependentsOf` is `false` (function comparison); compare results instead.
- `coneRank` refuses a cyclic cone catchably only because the verdict is read BEFORE the memo map is entered.
- `canReach`'s early exit helps only where the target dominates a sub-closure.
