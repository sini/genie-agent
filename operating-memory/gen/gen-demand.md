---
name: gen-demand
description: ARCHIVED library — read only to understand the typed demand cascade being re-expressed in gen-scope; never add a consumer or route new work here.
type: reference
---

**Status: ARCHIVED.** gen-demand has left the roster; its successor is **gen-scope** (the sole
execution engine). The cascade re-expresses there as `lib/cascade.nix` + `lib/folds.nix` under claim
vocabulary (`mkClaim`, `resolveClaims`). `adapters` retired without moving. The repository stays
readable, unmaintained, because the stratification driver in gen-scope has not fully landed and
reads this repository as its source. **Do not add a consumer. Do not route new work here.**

**Purpose (historical):** a typed demand cascade. Registered **kinds** resolve **demand** values
(`{ _type = "gen-demand/demand"; kind; subject; … }`) into resources + wiring + sub-demands. A
stratified, terminating fold over a registration-time kind DAG resolves the whole multiset with a
provenance trace. Example: a "service" demand desugars to a "secret" and a "volume" demand, and two
services needing the same secret dedup onto one artifact.

**Depends on:** gen-prelude, gen-graph (`condensation`, one call site); gen-select optional (only for
`adapters`).

## API (as it stood)

- `mkKind { name; below ? []; resolve; dedupKey ? null; fold ? null; }`; `mkKinds [kinds]` validates
  the DAG (duplicate name, unresolved `below`, cycle, self-loop).
- `demand { kind; subject; …payload }` — `subject` must carry `id_hash`.
- `resolveAll { kinds; demands; ctx; }` → `{ resources.<kind>.<key>; wiring.<id_hash> = { subject; byKind.<kind> = [ value ]; }; trace = { demands; resources; wiring; }; }`.
- Resolver contract: `resolve = demand: ctx: { resources ? {}; wiring ? {}; demands ? []; }`; every
  emitted sub-demand's kind must be in the emitter's `below`.
- `wiringFor`, `spliceWiring { resolution; subject; combine ? folds.one; }`.
- `folds.{same,one,list,mergeAttrs,byKey}` — uniform `key -> [v] -> v` (except `list` and `byKey`).

## Laws worth keeping (they carry into the gen-scope re-expression)

- **Stratification (Apt, Blair & Walker 1988):** each kind depth is a stratum; a dedup `fold` runs
  only when its stratum's fact set is complete. Acyclicity is checked at registration: stratifiability
  as a definition-time error.
- **Termination by induction, not by an iteration cap:** every `below` edge strictly decreases depth,
  so `maxDepth + 1` strata is a theorem.
- **Witness provenance (Cheney et al. 2009):** artifact ↦ the demand instances that produced it, with
  derivation paths. Semiring provenance is deliberately not implemented; traces are records.
- **Emission and consumption are separate**; fold-less kinds never last-wins (collisions throw).
- Output is byte-stable across evaluations.

## Traps (still instructive)

- `demand` canonicalizes `kind` lazily: a bad kind builds a fine value and throws only when forced.
- A reserved payload key is recorded at construction, thrown only at `resolveAll` intake; a payload
  `_type` is silently overwritten.
- `mkKinds` on an attrset ignores the attribute names; `kind.name` is the key.
- `dedupKey` and `fold` must be declared together.
- Schedule is stratum-major descending: a sub-demand lists before a later root.
- A kind's `fold` applies to singleton groups too, changing the value shape (`folds.list` ⇒ `[ "a" ]`).
  `trace.folded` says the kind declares a fold, not that fragments merged.
- An empty `wiring` (`{ }` or `[ ]`) drops the subject from `wiring` entirely; an unused kind is absent
  from `resources`, not `{ }`.
- `folds.same` on function-bearing fragments aborts UNCATCHABLY (functions are never `==`, and the
  mismatch diagnostic calls `toJSON`).
- The select adapter maps a subject's `type` to the selector's kind: no `type` throws; no `id_hash`
  makes every identity selector silently false, so `sel.not (sel.entity …)` KEEPS it.

## Working in it

Read only. If you must run it: `nix flake check ./ci` from the repo root.

Related: \[[gen-overview]\] \[[gen-dispatch]\]
