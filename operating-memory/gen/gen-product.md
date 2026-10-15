---
name: gen-product
description: Working in gen-product, the graph-product library (Cartesian/tensor/strong/lexicographic) with slices, fibers, restriction, quotient and containment chains.
type: reference
verified: unverified
---

**Purpose:** graph products as first-class operations over accessor-graphs. It builds the four standard
products from named factor specs and answers structural questions about the resulting lattice: cells,
slices, fibers, projections, restriction to a sparse membership, quotient, and containment chains (the
specificity ladder settings precedence uses). Lazy in and lazy out. In the framework, a product is how a
fleet's dimensions (for example host × user) become one addressable graph. It builds products and never
decomposes them: prime factorization and recognition are explicit non-goals.

**Depends on:** gen-prelude only. gen-graph is a test-only dev input. nixpkgs-lib-free, enforced by
`ci/tests/purity.nix` over `lib/**.nix`, `flake.nix`, `default.nix`.
**Used by:** gen-select (`adapters.product.mkContext`, a structural translator with no gen-product
import), gen-settings (containment chains as precedence layers), gen-class (quotient), the hub.
**Not its job:** traversal and query combinators (gen-graph; a `<pgraph>` *is* an accessor record, so
pass it directly), minting `id_hash` (gen-schema; this library only reads it), user-facing rendering of
a cell, emitting membership from policy.

## Layout

`lib/product.nix` (constructors), `lib/adjacency.nix` (per-kind edges), `lib/view.nix` (the view
builder, codec, `notANode`), `lib/factor.nix` (factor normalization and its refusals),
`lib/membership.nix` (restriction, enumeration strategies), `lib/quotient.nix`, `lib/chain.nix`
(containment chains, lattice graph), `lib/show.nix` (error-message rendering only).

## API

`import ./lib { prelude; }` (required). Root `default.nix` takes all-defaulted args and self-fetches the
locked gen-prelude; its `wire` formal is the one place the `follows` rule is declared.

- `productN kind [factorSpec]` (`cartesian|tensor|strong|lexicographic`); binary sugar `cartesian f1 f2`,
  `tensor`, `strong`, `lexicographic { major; minor; }` (a record because it is not commutative).
- Factor spec: `{ dim; graph; key ? (e: e.id_hash); entryOf ? graph.nodeData; }`. A bare accessor-graph
  is accepted with an identity codec and a **positional** dim name (`"0"`, `"1"`).
- Addressing: `nodeAt coords pg -> cellId`, `coordsOf cellId pg`, `nodeCoordinates pg` (row-major).
  `cell`/`cells` are tombstones that throw and name their replacements.
- Sub-structures: `slice partialCoords pg`, `fiber dim entry pg`, `projectTo dim pg`,
  `restrict { cells ? null; relations ? []; predicate ? (_: true); } pg` (restrict twice conjoins).
- `quotient { key ? …; classData ? …; keepSelfLoops ? true; } classOf graph`: works on any
  accessor-graph.
- `containmentChain coords linearization pg -> [{ fixed; free; slice; rank; }]` (`2^|D|` entries);
  `linearizeByDimOrder dims`, `linearizations.byRank ranks`; `latticeGraph dims` (covering relation).
- `show.node`, `show.subset`: for throw messages only.
- A `<pgraph>` is `{ edges; parent; nodes; nodeData; product = { kind dims factors cellOf coordsOf base restriction def enumeration }; __cells; }`. cellIds are opaque `builtins.toJSON` of the ordered keys.

## Invariants

- Every accessor forces only what a traversal visits. Documented exceptions: `nodes`/`nodeCoordinates`,
  lexicographic edges at a non-final dim (forces the trailing factor's nodes), and `quotient` (forces the
  input's node list at every accessor).
- Membership indexes are materialized thunks, so an unprobed restriction builds nothing.
- Caller contract: a supplied `key`/`entryOf` must **return or `throw`** on a non-node, never abort.
- Malformed input is refused **by name** (`malformed-factor`, `malformed-membership`, `not-a-node`), never
  misattributed.

## Working in it

```sh
nix develop ./ci --command ci                # suites, guarded
nix develop ./ci --command ci --tests-error  # error-plane cells, guarded
nix flake check ./ci                         # what CI runs; unguarded
```

`ci` refuses when any file under a declared read root is unknown to git; the remedy is `git add` or a
move. The bare forms read a git-filtered tree, so an **untracked cell is silently absent** and the run
stays green. A cell that pins an uncatchable abort goes on the error plane (`ci/tests-error.nix`,
`expectedError`), never in `flake.tests`, because `checks.default` forces every test expression.

## Traps

- Restriction `cells` hold **coords**, not cellIds. A malformed element raises `malformed-membership`
  when forced (catchable).
- A naive registry `entryOf = id: entries.${id}` aborts with a missing-attribute error that `tryEval`
  cannot catch, instead of `not-a-node`. A string coordinate under a caller `key` that reads a field
  aborts too; under the default `key` it is a named refusal.
- On the identity codec, not-a-node detection is vacuous: any value passes `nodeAt`.
- A slice speaks **free** coordinates only; its cellIds are a different id space from the parent's, and
  naming a fixed dim throws. A restriction `predicate` still receives **full** coordinates.
- `productN kind []` is K1 for every kind, but K1 is a unit only for cartesian, strong and
  lexicographic. A tensor product with K1 is edgeless.
- A unary product is isomorphic to its factor but not equal (cellIds are JSON-wrapped).
- `latticeGraph` is **not** an accessor-graph: `edges` is a list of labeled records, with no `nodeData`.
- `byRank` exists only under `linearizations`. A linearization must name every free dim.
- A predicate-only restriction enumerates the **full** product.
- Quotient node ids are class keys; intra-class edges become self-loops unless `keepSelfLoops = false`.
- `parent` is constantly `null`; the lattice is flat. Cells carry no identity of their own; identity is
  on the coordinate entries.

Theory: Hammack–Imrich–Klavžar, *Handbook of Product Graphs* (products on directed adjacency); Kahn 1974
(demand-driven accessors); Mokhov 2017 §4.6 for condensation only. "Quotient by arbitrary `classOf`" is
this library's own step, not Mokhov's; cite the subsection title so the claim stays checkable. Davey &
Priestley (the boolean lattice `2^D`).
