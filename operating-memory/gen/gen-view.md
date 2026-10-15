---
name: gen-view
description: Working in gen-view, the substrate's derived-view constructor (view definitions as data, materialized view relations over scope graphs).
type: reference
verified: unverified
---

**Purpose:** the substrate's **derived-view constructor**. A view *definition* is plain data; a view
*relation* is the named result of materializing it over a scope graph. Registry, topology, channel, role
and movement are **one construction** at three key shapes (`movement` ≡ `channel`; `registry` ≡ `role`
modulo a field name). Do not "differentiate" them to make a tidier claim true. In the framework, this is
how content moves along edges and how queryable derived relations are held.

**Status:** provisional container. The *library* name is temporary (its constructs will fold into a
larger library as a sublibrary); the *construct* names are permanent and each is grounded at a primary
source. Do not weaken a construct name because the container is provisional.

**Depends on:** gen-prelude, gen-graph (`lib` is a function of both). gen-scope is a **ci-only** input:
the query authority (`engine`) is injected as a field, which keeps `lib/` evaluator-free. A test
asserts that absence over `lib/` with a positive control. Do not "simplify" by importing the authority.
**Inherited:** most of the surface arrived by retirement of gen-edge (the `(S,T,P,M)` content-movement
algebra, Kahn-ordered materialization, the trace/`hashTrace` oracle cluster) and gen-pipe (channels,
map/filter/fold/route operators, provenance). Bind the names here; route no work to the archived repos.
Some surfaces did **not** arrive (source re-walk, a producer `contribute`, `deferred`); minting one is a
design decision, not a lookup.
**Not its job:** answering questions without holding structures (gen-select), the labelled walk and Kahn's
algorithm (gen-graph; composed, never reimplemented), minting (gen-identity).

## API (by layer)

- Raw calculus: `edgeLabels`, `dataOrder`, `relations`, `relatumLabels`, `carrier`, `scopeGraph`,
  `relationEntries`, `relationLookup`, `carrierElements` (the five carrier elements; `relatumLabels` is
  a published constructor but **not** a sixth element, so do not "complete" the enumeration with it).
- Declaration: `viewDefinition`, `definitionFields`, `compositionFields`, closed enums `combines`,
  `tieSets`, `dedups`, `directions` (+ `*Arms`).
- Materialization: `viewRelation` (needs `engine`; lifts the graph into the calculus and walks it with
  `resolve`; `direction = "inbound"` walks the converse).
- Accumulation/order: `readsOf`, `writesOf`, `unit`, `accumulatorRelation`, `accumulatorOrder`,
  `orderedFoldOf`, `cell`. `boundedWellDefinedSchedule` computes only the no-cycle conjunct of Vogt's
  bounded well-definedness, returning `{ equations; }` or refusing.
- Families: `placement`, `transform`; `compositions.{ movement channel registry topology role }`.
- Reference: `referenceResolution` (forward; total delegation to the injected authority; one datum or the
  authority refuses an ambiguous multi-candidate set) and `neededBy` (reverse; **gathers** all importers,
  no refusal). Both require `marks` (the query's `bound`).
- Oracle cluster: `trace`, `traceEntryOf`, `renderTrace`, `renderEntry`, `edgeSortKey`, `hashTrace`;
  `headPositions`, `joinedTrace`.

## Invariants (rules that bite)

- **Nothing is defaulted.** Every definition field is required, and so are `marks` and `orderMark` at
  materialization. "No marks" is `_: [ ]` written down. If you are about to add a default, add a refusal.
- The order mark is an **argument** of `viewRelation`, never a field of the definition (mark outer,
  lexicographic). Its alphabet check against the definition is the seam's own: before it existed, a
  definition and a graph over disjoint alphabets composed and answered silently.
- `L` (labels) is structural only; content lives in `R`. Label order is total over the alphabet; an
  unranked letter is refused. Edge-label classification is total over `L`, `R`, `Λ`, pairwise disjoint.
- `scopeGraph.data` is a **plain component** (a list of `{ scope; relation; datum; }`), so no traversal
  changes membership or filing. Do not reintroduce an arrival-mode family. A datum's **value** may still
  depend on graph shape. That door is lawful (computing a value is authoring it); do not claim
  "walk-dependence is unsayable".
- `referenceResolution` and `neededBy` stay **two constructs**, not one with a `direction` field: their
  dispositions differ (refuse versus gather). `neededBy` asserts duplicates (a node reachable twice
  contributes twice) and an empty gather is the ordinary case, never a refusal. There is no `codomain`
  field: a refusal is not a cardinality, and the fact is owned by the delegate.
- The fold may not reorder or dedup by rank. The ordering door never accepts the raw labelled-edge
  accessor (a semantics change that does not throw).
- No identifier is named `materialize`: the act has no term at the primaries.
- Fingerprint a topology with `hashTrace`, never `edgeSortKey` (a projection, not injective).
  `edgeSortKey` refuses unknown fields; `renderEntry` discloses by type and never refuses. Keep them so.

## Working in it

```sh
nix develop ./ci --command ci                # guarded
nix develop ./ci --command ci --tests-error  # error-message cells, guarded
nix-unit --flake ./ci#tests ; nix-unit --flake ./ci#testsError   # unguarded
```

- **`nix flake check ./ci` does not read `testsError`.** It warns "unknown flake output" and passes while
  error-plane cells are red. Run both planes; the pre-commit hook (`ci`, `ci-error`, `treefmt`) covers it.
- Error-message cells live outside `./tests` structurally, because `checks.default` forces every `expr`.
- `ci/fixture.nix` is the shared fixture; build mutants with `f.mkDefinition { <one field> = …; }` so a
  fixture and its mutant differ in exactly one respect.
- `ci/tests/surface.nix` pins the export list; update it with any export change.

## Traps

- Two Nix lambdas are never equal, not even a value against itself. Exclude raw-function fields from
  comparisons and check them by name.
- Do not quote a cell-count fraction in docs; it went stale on three consecutive commits. Name the cell
  set instead.
- Editing an existing oracle cell's regex to make a change pass has **moved the oracle rather than met
  it**.
- A refusal sweep needs a **populated** positive control, or it cannot tell a refusal from a legitimately
  empty answer.
- The frozen edge trace is topology evidence, not acceptance authority: two executions with different
  answers once shared a byte-equal fingerprint.

Theory: Manchanda & Warren (view definition/relation), Néron et al. 2015 (reference resolution rule),
Vogt (bounded well-definedness, second conjunct only), Knuth 1968 (one direction of reduction only).
