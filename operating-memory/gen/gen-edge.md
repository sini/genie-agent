---
name: gen-edge
description: ARCHIVED library — the (S,T,P,M) content-movement edge, now retired into gen-view; read for the export→gen-view map and the edge-model lessons, never bind it in new code.
type: reference
---

**Status: ARCHIVED.** gen-edge has left the roster and is no longer a hub input; it is orphaned for
reference (no content deleted, nothing maintained). **New code binds gen-view**, never this library.
No consumer is left: a census of the binding token across every other gen repository read 0, with
positive and negative controls.

**Purpose (historical):** the content-movement contract. Every move of content between graph
positions is one edge `(S, T, P, M)`: source, target, attrpath, mode. gen-edge owned the edge record,
edge-set derivation for a root, Kahn-ordered materialization over a static per-root projection Π, and
a frozen, hashable edge trace `E` (the parity oracle).

## Where each export went (bind the right column)

- `edge` → split: S/T → `viewDefinition.root` / `.direction` / `.admission` / `.channel`; P/M →
  `placement.place`; kind → `traceEntryOf`'s `kind`. The record does not move whole.
- `modes` (`merge`, `nest`, `nest-verbatim`) → `placement.modes`.
- `defaultFold` → `compositions.movement` + `placement.place { mode = "merge"; path = [ ]; }`.
- `sources.collected` → `readsOf`; `sources.value` / `keyedValue` → the authored `scopeGraph { data }`.
- `targets.root` / `targets.output` → `placement.targets.root` / `.output` (output is a named arm).
- `edgesFor` → `viewDefinition.root` → `viewRelation.contributions`.
- `toposort` → `accumulatorRelation` + `accumulatorOrder`.
- `readsOf` / `writesOf` → same names in gen-view, defined on the MATERIALIZED result; `writesOf` takes the placement.
- `project` → dial by dial: `relationLookup`, `dedups`, `viewRelation`'s marks → `boundedBy`, `scopeGraph.scopes`.
- `materialize` → `viewRelation.value` + `placement.place`, or `orderedFoldOf`. (gen-graph's
  `materialize` is edge-map construction, a different thing.)
- `adapt` → `transform.map`: a new NAMED result re-folded from its own contributions, never a patch.
- `combine.merge` → `combines`, a closed whitelist of arms each declaring `op`, `unit`, `associative`.
- `setAttrByPath` → `placement.setAttrByPath`.
- HELD (no destination): `sources.synthesize`, `sources.rewalk`, `project`'s `classInject` dial.
- The oracle cluster (`trace`, `renderTrace`, `renderEntry`, `traceEntryOf`, `edgeSortKey`,
  `hashTrace`) retired LAST, because it was the instrument validating the retirement.

## Lessons that outlive the library

- **A topology fingerprint is not acceptance authority.** The final acceptance run found two
  executions with DIFFERENT answers sharing a byte-equal trace hash. The edge trace is topology
  evidence; acceptance authority is end-result equivalence.
- **Retire by marking, not cutting.** The surface is marked per export with its destination; the
  validating instrument and its inputs stay evaluable until the acceptance has run.
- **Kahn (1962), not Gilles Kahn (1974):** `toposort` was Kahn's topological sort; cycles abort
  loudly naming the `(target, channel)` chain.
- **Bernstein's conditions, relaxed:** read/write sets order the fold; output independence is relaxed
  (same-cell writes allowed, discharged by canonical cell order).
- **Merge here was associative-only**, deliberately not framed as a semilattice or CRDT (not
  commutative or idempotent). A `merge` channel's value is an ordered LIST of contributions.
- Schema versions were strictly additive: a topology using no later feature renders a byte-identical
  earlier trace.

## Traps (still instructive for gen-view work)

- The `graph` argument was the caller's accessor record, not gen-graph's lib: two things sharing a name.
- `parentOf` was never consulted although the README supplied it.
- Validation was often deferred: an unresolved `members = null` source constructed and traced, then
  threw at ordering; a `nest` to an `output` target constructed and failed at `writesOf`; name
  coercion failures survived a shallow `tryEval` (use `deepSeq`).
- `kind = null` meant the key was ABSENT from the trace entry, not present-and-null.
- A `nest` edge alone wrote the target's INPUT cell; nothing appeared on the config face without a fold.
- Declared edges were gathered graph-wide and isolation-blind.
- Dedup was first-occurrence-wins over non-null keys; `nest-verbatim` was dedup-exempt.
- The README recorded an output order the code did not produce: run documentation snippets, do not trust them.

## Working in it

Read only. `nix flake check ./ci` still evaluates the cluster as a record.

Related: \[[gen-overview]\] \[[gen-bind]\] \[[gen-delivery]\]
