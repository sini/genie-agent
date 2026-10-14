---
name: gen-rebuild
description: Working in (or reading) gen-rebuild, the ARCHIVED pure-Nix incremental rebuilder whose content moved to gen-memo.
type: reference
---

**Status: ARCHIVED.** Successor: **gen-memo**, which carries a strict superset of this export set. One
incremental plane over the sole evaluator was ruled, and this shell retired. The repository is kept, not
deleted, so existing pins still resolve. It is off the hub roster. **Do not route new work here and do
not add a consumer.** The traps below still describe the mechanism gen-memo inherited.

**Purpose (historical):** the rebuilder dimension of *Build Systems à la Carte* (Mokhov et al. 2018) as a
pure-Nix library. It owns a flat, relocatable result store plus a per-key verifying trace, decides node
reuse, and drives change propagation over a **caller-supplied** `recompute`. "Flat" and "relocatable" are
this library's own properties, not the paper's: §3.1 defines the store only as keys to values.

**Depends on:** gen-prelude, gen-graph (all nine structural queries delegate there: reachability,
condensation, cycles, rank), gen-scope (a required argument that is **never used**).
**Used by:** formerly gen-resolve only.

## API (flat namespace, 24 names; root is `{ prelude, graph, scope }: …`)

- Accessor contract (consumed): `{ nodes; edges : id -> [id]; nodeData; parent; }`. Edges point
  consumer to producer, so the dependent cone of `x` is `graph.dependentsOf accessor x`.
- `build { accessor; recompute; hashOf; fixpoint ? null }` -> `{ store; trace; accessor; recompute; hashOf; }` (+ `fixpoint` only when given). `trace.<id> = { deps; hash; }`.
- Data change: `override ctx id decls` (fused `propagate ∘ applyDelta`), `propagateEager ctx { id = decls; }` (takes an attrset), `restabilize ctx id decls` (cycles; needs a fixpoint ctx).
- Staged change: `applyDelta`, `batch ctx [{ id; newDecls; }]`, `propagate`, `force ctx id`,
  `forceCtx ctx id -> { value; ctx; }`.
- Topology: `retract ctx id policy` (`null`/`"error"`/`"recompute-without"`), `applyEdgeDelta ctx id edges`, `mkAccessor`.
- Impact: `affected` = `impactOf` (cone), `dirtySet ctx ids` (over-approximate), `affectedSet ctx { accessor'; changedIds; }` (exact, hash post-filtered). The attribute is literally `accessor'`.
- Reuse: `verify`, `earlyCutoff`, `needsEval`. Provenance: `support`, `supportDirect`, `why`, `whyNot`.
- Cycles: `runScc { …; lattices = { <id> = { bottom; join; eq ? (==); widen ? null; maxIter ? 100; }; }; }`.

## Invariants

- `lib/` is nixpkgs-lib-free, enforced by a named purity test over `lib/**.nix`, `flake.nix` and
  `default.nix`.
- Divergence is guarded **structurally** (prechecks plus `maxIter`), never by catching, because
  `tryEval` cannot catch a black hole.
- `override` is sound for data changes with fixed edges only; topology changes go through
  `lib/structural.nix`.
- Cyclic convergence rests on the consumer's **unchecked** monotonicity and finite-height obligations;
  `maxIter` is the only runtime guard.

## Working in it

`nix flake check ./ci` (CI runs the same with `working-directory: ci`). Drift check:
`nix eval --json .#lib --apply builtins.attrNames`.

## Traps

- **Merge order shadows definitions.** `lib/default.nix` folds files with `//`, so `drivers.nix`'s
  `override` shadows `override.nix`'s, which is unreachable. Tell: the result carries `pending`.
- `lib/hash.nix` is not folded in, so `hashGuarded`/`hashEq`/`hashMoved` are private.
- **`tryEval` does not catch `toJSON` on a function, nor infinite recursion.** Both kill the whole
  evaluation. Screen for functions before hashing; a function-valued node gets `hash = null` and is
  always dirty.
- With `fixpoint = null`, a cycle is a catchable throw. Passing `fixpoint` alone does not license a cycle:
  every cyclic node needs a declared lattice. A non-fixpoint ctx has no `fixpoint` key, and `restabilize`
  on it throws.
- `retract ctx id` with two arguments silently returns a function (curried), not a ctx. Policy `null`
  means `"error"`, which throws when dependents remain.
- `dirtySet` never consults hashes: a no-op change lists the whole cone while `affectedSet.affected` is
  empty. Use `affectedSet` to ask "whose value moved".
- `applyDelta`/`batch` leave `store` and `trace` stale until `propagate`. `propagate` adds
  `pending = { dirty = []; }` even when there was nothing to do; `propagateEager` returns no `pending`
  at all. The two families' ctx shapes differ.
- Edge lists must be deduped (`mkAccessor` does it); duplicates double-count in the recompute fold.
- `why`'s fast path has no `paths` key; `whyNot` returns `null` for "was recomputed".
- `earlyCutoff` never cuts when the old hash is `null`.
- `force` discards the drained ctx, so a loop of `force` re-drains each time. Use `forceCtx`.

**Theory, with the overclaims named.** Implements Mokhov 2018. Informed by Reps–Teitelbaum–Demers 1983
(AFFECTED, cutoff; true `O(|AFFECTED|)` not reached), Acar 2002 (change/propagate; the "reverse-topo
splice" is this library's own name, not Acar's), Adapton (`force` is full drain, not selective repair),
Radul–Sussman (`retract` borrows the name `kick-out!`, but theirs is reversible and deletes nothing),
Datafun (finite-height iteration), Tarjan (SCCs via gen-graph). Do not attribute a library's own property
to the paper it cites.
