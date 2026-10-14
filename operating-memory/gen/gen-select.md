---
name: gen-select
description: Working in gen-select, the selector algebra (CSS-like predicates as data) for attributed graph positions.
type: reference
---

**Purpose:** a selector algebra for attributed graph positions. Constructors build plain-data predicate
values `{ __sel = tag; … }`; `matches selector id ctx` evaluates one against a caller-supplied
five-accessor context. Selectors are how policies and rules say "which nodes": by attribute, by entity
identity, by kind (and subkind), by tree position, by product coordinate. Because selectors are data, a
rule set can be compared and deduplicated.

**Depends on:** gen-algebra only (intensional functions and the identity-regime discipline,
`conservativeEq`, `identityOf`; imported, not vendored). Dependency budget is **exactly one**, enforced.
**Used by:** gen-dispatch (reads `__sel` off plain data, with no input on this library), gen-view (which
inherited gen-pipe's channels; gen-pipe's `sel` re-export retired into a direct bind of this library),
the hub, gen-demo.
**Not its job:** building the graph (gen-scope, gen-graph), minting `id_hash` (gen-schema; this library
only reads it and hashes nothing), building products (gen-product), choosing a winner among matched
rules (gen-dispatch).

## API

`inputs.gen-select.lib` is a bare value; `import ./. { algebra = <gen-algebra.lib>; }` otherwise. The
root's `wire` formal declares the `follows` rule once.

- Leaves: `star` (a value), `attrs { k = v; }`, `entity kindValue entry` (entry needs `id_hash`),
  `kind kindValue` (needs gen-schema's mint mark), `subkind kindValue` (kind or a transitive ancestor).
- Combinators: `and [s]`, `anyOf [s]` (the `any` export is a tombstone naming `anyOf`), `not s`.
- Structural: `has` (child), `within` (ancestor), `parentMatches`; sugar `child { parent; child; }`,
  `descendant { ancestor; descendant; }`.
- Escape hatch: `when (id -> ctx -> bool)`; pass an intensional record if the selector must compare.
  `isIdentified`, `selectorEq` (the dedup relation).
- Engine: `matches selector id ctx` (a non-selector is refused by name, catchably).
- Adapters: `adapters.scope.mkContext`, `adapters.registry.mkContext { nodes; data; parent; kind ?; kindFor ?; }`,
  `adapters.product.mkContext { nodeIds; coordsFor; …; kinds ? {}; }` plus `coord dim kind entry` and
  `inSlice`, `adapters.graph.mkPredicate selector ctx id`, `mkSelectPredicate selector ctx data`.
- Context contract: `data`, `parent`, `children`, `ancestors`, `siblings`. `data` may project reserved
  `__identity` (`{ id_hash; kind; entry; }` or `null`, merged **last** so no decl shadows it) and `__coords`.

## Invariants

- nixpkgs-free; root flake inputs must be exactly `[ "gen-algebra" ]`, read from the lock (a token check
  alone would let a second dependency in unnoticed). Both in `ci/tests/purity.nix`.
- Kinds compare by **minted identity** (`kindEq` semantics). A `//` copy of a kind value is refused by
  name at every comparison. A sealed collision is refused by name.
- `selectorEq` on `when` uses conservative equality: digest equality when minted, `==` on the reified
  value otherwise. The name never decides.

## Working in it

```sh
nix develop ./ci --command ci                # guarded
nix develop ./ci --command ci --tests-error  # error plane, guarded
nix flake check ./ci                         # what CI runs; unguarded (untracked cells silently absent)
```

Drift check: `nix eval --json .#lib --apply 'l: builtins.attrNames l'`.

## Traps

- `entity`/`kind` against an identity-blind context **throw**; they do not return false. `kind` throws on
  a kind-blind projection even where `entity` works. A registry context built without `kind`/`kindFor`
  projects `kind = null`, so every `sel.kind` throws. Pass `kind`.
- Product cells are never entity-backed (`__identity = null`), so `entity`/`kind` are **silently false**
  there. Use `coord`/`inSlice`. A cell missing the coordinate dim is `false`, not a throw.
- `coord` is on `adapters.product`, not top level, although `matches` dispatches the tag.
- `and []` is true, `anyOf []` is false, `inSlice {}` is true.
- `attrs` treats a missing key as no-match.
- The scope adapter lets node `type` override a decl key named `type`.
- `child`/`descendant` have no tag of their own; both are `and` at runtime.
- `selectorEq` on two `when`s wrapping the same bare lambda is `false`; use an intensional record. It is
  coarser than `==` for entities (ignores display `name`) and, on `when`, precise only by allocation: a
  value equals itself but not a separately constructed equal-shaped one.
- **A reader that branches on `? __mint` and then reads `.minted` aborts uncatchably** on an unmintable
  value. `__mint` is a tagged sum; dispatch on the tag, never on presence.
- Argument order differs: `matches sel id ctx` versus `mkPredicate sel ctx id`.
- Constructors reject name strings (`entity "user"`, `kind "user"`) at construction.
- An unknown `__sel` tag throws.

Theory: Palmer et al. 2024 *Intensional Functions* (conservative equality; its Theorem 1 does not
transfer, because gen is not λITS); CSS Selectors Level 4 (`:has`, `:not`, combinators, type selectors
lifted to kinds); Neron et al. 2015 (`entity` as declaration identity; the resolution calculus is **not**
implemented); product-graph vertex membership for `coord`.
