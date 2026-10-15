---
name: gen-algebra
description: Working in or calling gen-algebra — record algebra, layer folds, Either, and intensional-function identity (mkIntensional / conservativeEq).
type: reference
verified: unverified
---

**Purpose:** the pure-algebra root of gen. Leijen/Bracha records with scoped labels and layer
folding, Either combinators, and intensional-function constructors. `builtins` only, ZERO flake
inputs. It mints no identity itself: `mkIntensional` takes the mint INJECTED, because the one
minting authority is gen-identity, and importing it would form a cycle.

**Depends on / used by:** depends on nothing. Used by gen-schema, gen-select (imports
`conservativeEq` rather than vendoring it), gen-settings (consumes `foldLayersTraced`), gen-link;
the `__mint` sum it authors is read by aspects, dispatch, merge, program, schema, scope, select, types.
NOT its job: list/string utilities (gen-prelude), type checking (gen-types), minting (gen-identity),
fixpoint loops (gen-scope's `circular`), dataflow over channels (gen-view).

## Layout

- `lib/rec.nix` — the record algebra and the layer folds (`record.*`).
- `lib/either.nix` — `either.*`.
- `lib/intensional.nix` — `mkIntensional`, `conservativeEq`, the identity-regime readers.
- `lib/term.nix` — body-term formers (`__bodyTerm`), `isTerm`, `checkTerm`.
- `default.nix` — nullary: `import ./. { }`. `ci/tests/` — suites; `ci/tests-error.nix` — refusal cells.

## API

Records (Leijen §2) are `{ __entries = { label = [stack]; }; __order = [label]; }`:

- core: `empty`, `extend l v r` (push), `select l r` (head; throws if absent), `restrict l r` (pop;
  no-op if absent), `has`, `depth`.
- conversion: `emit` (heads only), `emitAll [labels] r` (full stacks for listed labels), `fromAttrs`,
  `labels`, `show`, `showCompact`.
- derived: `update` (throws if absent), `upsert`, `rename`.
- composition (Bracha): `combine { left; right; }` (left-biased; keeps both stacks), `mixin`,
  `mixinBeta`, `compose`. Row checks: `satisfies`, `assertSatisfies`.
- layer folds over PLAIN ATTRSETS, least-specific layer first: `foldLayers { strategies; defaults; layers; }`, `foldLayersTraced { …; layerNames; entryTransform; }` → `{ value; provenance; }`,
  `foldNestedLayers`, `flattenAttrs { strategies; prefix; } attrs`, `unflattenAttrs`.
  Strategies: `replace` (default), `append`, `recursive`; `semilattice-set` in the traced fold only.

Either: values `{ right = v; }` | `{ left = e; }`. `right`, `left`, `pipe` (short-circuits),
`collectErrors` (runs all; `left` is always a LIST), `mapR`, `chain`. Test `? right` directly.

Intensional functions:

- `mkIntensional hashIdentity registry ctor args` — four curried args; `registry = { revision; members; }`. Returns a callable `{ ctor; args; name; closure; fn; __mint; __functor; }`.
- `conservativeEq a b` — regime-dispatched: digests where minted, whole-value `==` otherwise.
- readers: `identityOf`, `regimeTagOf`, `isExact`, `comparisonSubject`, `hasMark`, `markOf`,
  `preimageTagOf`, `componentsPreimage`, `sealedCollisionEq`, `sealedMarker`.

## Invariants and laws

- **Zero inputs binds `flake.nix` and `lib/`, NOT `ci/`.** The contract protects a consumer's
  closure; `ci/` is its own flake and may take the real gen-identity mint to test the composition
  of encoder and constructor honestly. A stand-in mint left that composition untested.
- **`__mint` is a tagged sum**: `{ minted = "<digest>"; }` or `{ unmintable = { ctor; reason; }; }`.
  Readers dispatch through `identityOf`; never branch on `? __mint` and read `.minted` raw.
- **A mark is not an identity.** A marked value beside non-empty `__sealed` components is a bucket
  label (`isExact` false): bucket by it, then decide within the bucket with `sealedCollisionEq`.
- **`__witness`** is a producer's declaration, by field NAME, of which fields witness its mark;
  this library reads no producer's field spelling.
- **A term carries `__mint`.** `checkTerm` refuses a hand-spelled `__bodyTerm` without one
  (`term-not-constructed`). Recognise refusals only through the exported `isRefusal`.
- **The constructor is an encoder** (Palmer): the author supplies `(ctor, args)` and the registry
  builds the function, so an under-complete closure is inexpressible. The registry `revision` is in
  the identity coordinate because the registry is open; get the revision wrong and identity is wrong.
- `conservativeEq` separates values sharing a `ctor` but differing in `args` (a name-only relation
  merged behaviourally distinct values).
- `foldNestedLayers` is NOT associative on layers (`[{a.b.x=1} {a.b=5} {a.b.y=9}]` ⇒ `{a.b.y=9}`, but
  pre-folding the last two keeps `x`). Do not assume the flat folds' associativity.
- `entryTransform` is applied per entry, on demand, including the default entry; a diverging entry
  does not poison siblings. Never replace it with a `map` over the finished provenance.

## Working in it

- `nix develop ./ci --command ci` (guarded); `nix flake check ./ci` is what CI runs, unguarded.
- Purity: `ci/tests/purity.nix` refuses `nixpkgs`, `lib.`, `{ lib }`, `evalModules`, `mkOption` in
  `lib/**.nix`, `flake.nix`, `default.nix` (comment-stripped).
- Refusal cells go in `ci/tests-error.nix`; value cells in `ci/tests/<area>.nix`.
- Drift check: `nix eval --json .#lib --apply 'l: builtins.attrNames l'` plus the namespace names.

## Traps

- `semilattice-set` throws in `foldLayers` / `foldNestedLayers`; it only works in `foldLayersTraced`.
- An unknown strategy is SILENT until some layer contributes that field.
- A field named only in `strategies` never appears in output (keys come from defaults + layers).
- `foldLayersTraced` asserts `layerNames` is 1:1 with `layers`; omitting it fails with an
  unhelpful integer-equality assertion.
- Passing a `record` as a fold layer leaks `__entries` / `__order` as ordinary fields.
- `conservativeEq` on a bare lambda throws ("expected a set") rather than returning false; guard with
  an `isIntensional` check, as gen-select does.
- `either.pipe` tests `? left` first; `mapR` / `chain` test `? right` first. A step returning a bare
  value fails at the NEXT step. `collectErrors` forces every function, even after a `left`.
- `restrict` on an absent label is a silent no-op; `select` / `update` / `rename` throw.
- `emit` drops shadowed values; only `emitAll [label]` keeps them. `combine` keeps the right stack
  reachable through `restrict`.
- `labels` is not insertion order: `fromAttrs` seeds lexicographically, then `extend` appends.
- `show` on a function-valued field throws an error `tryEval` cannot catch.
- `flattenAttrs` keys are RFC 6901-escaped (`.` → `~1`, `~` → `~0`); a strategy for a literal dotted
  key is written `"a~1b"`. `{}` is a leaf. `unflattenAttrs` refuses non-canonical escapes.

Related: \[[gen-overview]\] \[[gen-dispatch]\] \[[gen-aspects]\]
