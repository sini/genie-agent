---
name: gen-types
description: Working in gen-types, the pure nixpkgs-lib-free structural type checker (verify -> null | error) and type identity.
type: reference
---

**Purpose:** a pure, `nixpkgs.lib`-free structural type **checker**. Every constructor returns a checker
record whose `verify` maps a value to `null` (inhabits the type) or an error string. No merging, no
priorities, no fixpoint. It also owns **type identity**: each checker's identity is minted over its
construction (constructor plus inert arguments), never over its name, so the merge engine can decide
whether two declared types are the same.

**Depends on:** gen-prelude, gen-identity (`hashIdentity`, the ecosystem's single minting authority,
injected). No gen-algebra input; it inlines its conservative-equality dispatch.
**Used by:** gen-merge (injects it as `types`; its union dispatch prefers a leaf's `verify`), gen-schema
(field-aware validators, `validateInstances`, `refined` built through `mkIdentity`), gen-settings, the hub.
**Not its job:** merging (gen-merge), registries and *instance* identity (gen-schema), position matching
(gen-select). gen-types validates a value; gen-schema registers a record.

## API

`inputs.gen-types.lib`; `import ./. { }` defaults `prelude` and `identity` to the `ci/flake.lock` pins.

- Checker record: `name` (`"listOf<int>"`), `verify`, `check v v2`, `__name` (base name), `__mint`
  (`{ minted = "type:<sha256>"; }` or `{ unmintable = { ctor; reason; }; }`), `__sealed` (path to
  comparison subject for sealed components), `__payload` (read via `payloadOf` only). `override` on
  `struct` results; `__refinements` on `refined` results.
- Primitives (values): `string`/`str`, `int`, `bool`, `float`, `number`, `path`, `pathLike`, `attrs`,
  `list`, `function`, `derivation`, `null`, `any`, `never`.
- Combinators: `checkedOption`, `checkedListOf`, `checkedAttrsOf`, `union [..]`, `intersection [..]`,
  `enum name [values]`, `tuple [..]`, `optionalAttr`, `struct name { m = t; }` with chainable
  `.override { total; unknown; verify; }`. `listOf`/`attrsOf`/`option` are tombstones naming `checked*`.
- Custom: `typedef name pred`, `typedef' name (v -> null | err)`. Refinement: `refined base (refinement | [refinement])`, `refinements.{ nonEmpty positive tcpPort }`. Closed keys: `strict [keys]`.
- Validators: `mkValidator { name; pred; message; }`, `runValidators kind [v] { name = inst; }` ->
  `{ right } | { left = [failure] }`, `formatErrors`, `defaultOnError`.
- Identity: `typeEq` = `conservativeEq`, `idOf` (identity demand; refuses by name), `payloadOf`,
  `mkIdentity`, `comparisonSubject`, `typeWitness`, `identityGuard`.
- Check-witness protocol: `witnessedCheck pred -> { check; _checkWitness; }`, `witnessRecord`,
  `rewritesCheck r` (true where `check` was rewritten, e.g. by nixpkgs `addCheck` or `// { check = …; }`).

## Invariants

- Identity is minted over the **construction**, never the name. A name is a lossy rendering: any
  relation keyed on it merges what the name does not carry. (Before the fix, `refined<int>` positive
  and tcpPort were "equal", every `strict` type was "equal", and the collision travelled through
  combinators.)
- A construction whose arguments include a caller lambda (`refined`, `struct … .override { verify }`,
  `typedef`) is **sealed**: `idOf` refuses by name rather than inventing an identity. Sealing is per
  component.
- For type equality, *finer* is the safe error.
- No field of a checker refuses when forced; the identity demand is the function `idOf`.
- `lib/` is nixpkgs-lib-free and module-system-free; the purity test arms its own oracle against a planted
  violation.

## Working in it

```sh
nix develop ./ci --command ci                # guarded
nix develop ./ci --command ci --tests-error  # error plane, guarded
nix flake check ./ci                         # what CI runs; unguarded
```

Drift check: `nix eval --json .#lib --apply 'l: builtins.attrNames l'`.

## Traps

- `verify` returns `null` for success, which is also the `null` type's inhabitant.
- `check` takes two arguments and checks only the **first**; the second is returned unexamined.
- `unknown = true` (default) **permits** undeclared keys. Close a struct with `.override { unknown = false; }`.
- `enum`'s first argument is the whole type name.
- The `optionalAttr` exemption is positional: wrapping it (`option (optionalAttr t)`) loses it.
- `listOf`/`attrsOf` blame names neither index nor key; `union` blames no member; `refined` adds no
  context frame.
- `union []` rejects everything; `intersection []` accepts everything.
- `pathLike` accepts any string; `derivation` is a duck-type test.
- `str` is an alias: names and blame say `string`.
- `runValidators` takes instances as an **attrset**; a list aborts the whole evaluation uncatchably.
- `union`/`intersection`/`tuple`/`struct` assert argument shape at construction.
- `defaultOnError` never returns.
- A bare checker carries no witness, so a hand `// { check = …; }` over one is not detected by
  `rewritesCheck`.

Theory: Findler & Felleisen 2002 (a type is a blaming predicate boundary, first-order core); Palmer et al.
conservative equality (no name arm); Milner 1978 transposed (finer is safe); liquid types as a style
influence only.
