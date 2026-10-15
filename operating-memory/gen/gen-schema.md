---
name: gen-schema
description: Working in gen-schema, the typed record registry (kinds, instances with content-addressed id_hash, registries, declaration vocabulary) on gen-merge.
type: reference
verified: unverified
---

**Purpose:** the typed record registry. Schema **kinds** are deferred modules carrying collections, ref
fields and a parent topology; **instances** are submodules with strictness and an injected
content-addressed `id_hash`; the **registry** option binds them. Driven on gen-merge's `evalModuleTree`,
not nixpkgs `lib.evalModules`. In the framework, kinds are entity types and instances are entity nodes;
`_edges` exposes the parent and ref edges as queryable data. It also holds the **declaration vocabulary at
both levels**: `declarationOf` (an option TYPE: this field points at an instance of kind K) and
`mkFieldDeclaration` (a VALUE: which instance, which field). One library holds both because they are two
halves of one relation; separated, a reference type and its inhabitants drift apart.

**Depends on:** gen-prelude, gen-merge (the merge engine, injected), gen-algebra (record algebra),
gen-identity (`hashIdentity`, the single minting authority, injected and **not** re-exported), gen-graph.
**Used by:** gen-settings, gen-select (reads `id_hash`, kind marks), gen-aspects, the hub, gen-demo.
**Not its job:** the merge engine and `types.*` (reach `mkOption`, `types`, `evalModuleTree` through
the hub's `gen.lib.merge`, never through this library: re-exporting another library's value re-hands its
build and creates type-identity hazards across pins), checking (gen-types), selection (gen-select),
resolution calculus (gen-scope), precedence strata (gen-settings).

## API

`inputs.gen-schema.lib` or `import ./default.nix { }`; `import ./lib { prelude; merge; algebra; identity; }`.

- Kinds: `mkSchemaOption { strict ? true; baseModule; collections; computed; mixins; mkType; keySemantics; specialArgs; }`, `mkSchemaEntryType`, `kindEq`, `evalSchema`. `inherits` composes parent kinds (by name
  or by kind value); cycles are refused by one walk.
- Instances: `mkInstanceType { … } kind`, `mkInstanceRegistry { refs; refinements; strict; derive; deriveEither; … } kind`. The registry `apply` pipeline: deferred-ref coerce, refinements, validators,
  derive, overlay.
- Identity: `mkIdentityModule kindName`, `identityHashForKind kind instance` (`null` when the instance
  cannot be that kind), `_identity.keys` to pin keys, `identity = false` on an option to exclude it.
- `mkStrictModule`; validators `mkValidator`, `mkFieldValidator`, `filterValidators`, `runValidators`,
  `validateInstances`, `formatErrors`, `defaultOnError`.
- `refined base refinements`, `refinements.{ tcpPort nonEmpty positive }`, `checkRefinements` (returns),
  `blame`.
- Refs: `declarationOf "<kind>"` (deferred, bound by a registry's `refs.<field>`) or `declarationOf instances` (direct), `setOf` (dedup by `id_hash`), `toSet`. Field values: `mkFieldDeclaration`,
  `isFieldDeclaration`, `fieldDeclarationsIn`, `fieldDeclarationMarker`. Old `ref`/`fieldRef*` names are
  published throws naming their replacements.
- `schemaFn` (methods), `mkMixin`, `composeMixins`, `beta`, `applyMixin`, `emitModule`, `mkCodec`,
  `renderDocs`.
- Schema introspection: `_kindNames`, `_topology`, `_refEdges`, `_edges`, `_roots`, `_leaves`,
  `_collectionKeys`, `_declarationKeys`, `_reservedCollectionKeys`.

## Invariants

- A kind value carries a provenance mark `__mint` minted over its distinguishing content (option types,
  collections, keySemantics, refs, computed fields). Content that may read instance data (`default`,
  `description`, `apply`, …) is never forced; it enters as a **sealed** component by path. Two kinds with
  one mark and unequal sealed content are **refused by name** by `kindEq`, not answered. A `//` copy of a
  kind value is refused by name (completion stamp `__kindSelf`).
- Admission reads the mark, not a `? kind && ? options` presence test (which admitted any hand-written
  attrset).
- Only **primitive** options enter identity; methods are never identity keys (a method reading an
  opted-out field once defeated the opt-out). Floats are admissible in identity only for `|v| < 2^53`:
  Nix `==` is not transitive above that.
- Reserved names (`__mint`, `__sealed`, `__kind*`, `__witness`, construction formals, module-syntax keys)
  are refused by name as collections, computed fields and declaration keys. A declared `__functor` once
  silently deleted the rest of a declaration.
- A key on a structured kind declaration that no reader consumes is refused by name.
- `fieldDeclarationsIn` **refuses** a function anywhere in a scanned position, wider than the hazard on
  purpose. The only sanctioned escape would be a *declared* schema annotation; never silently reopen
  the scan.
- `lib/` is nixpkgs-lib-free (purity test).

## Working in it

`nix develop ./ci --command ci` and `nix develop ./ci --command ci --tests-error` (guarded); CI runs
`nix flake check` in `ci/`. Behaviour that differs by evaluator is measured on Nix, Determinate and Lix.

## Traps

- Non-primitive options are **invisible** to identity: changing a `listOf str` leaves `id_hash` unchanged.
- `_identity.keys` naming an undeclared or non-primitive option throws. `_identity` is closed to `keys`,
  even under `mkIf false` (it is `lazyAttrsOf` because `attrsOf` drops an all-`mkIf false` key).
- A kind named `_x` constructs, but every kind-derived read (`_kindNames`, `_topology`, …) refuses it.
- A collection default that is neither list nor attrset needs explicit `merge`; the throw is deferred to
  first access. Merge is inferred: list `++`, attrset `//`. Every kind has `inherits`, `methods`,
  `validators`, `parent`.
- Strict is the default: an undeclared instance key throws; `strict = false` admits it as freeform.
- **Field-gated validators are silently skipped** when the kind lacks the field.
- Ref binding errors (unbound field, binding matching nothing, absent key) all throw. A deferred
  `declarationOf` merged where no registry binds it refuses by name; only `nullOr listOf setOf attrsOf lazyAttrsOf refined` are walked to bind it.
- `toSet`'s `member` throws on a value without `id_hash`.
- A method naming an undeclared config key throws at access. Mixins override the kind by default; `beta`
  reverses that.
- `mkInstanceRegistry` over a self-referential crossing (`options.hosts = mkInstanceRegistry {} config.schema.host`) is supported, so its kind guard is necessarily lazy (in `apply` and `default`).
  `mkCodec` guards eagerly.
- `lazy = true` refinements defer only when **every** refinement on the field is lazy.
- Open defect: `refined` over a container of a gen `submodule` is refused where nixpkgs' `addCheck`
  serves the accepted value. Refusing where nixpkgs serves is a parity defect, not a price.
- `types` from gen-merge contains six names that also exist at gen-schema's top level
  (`mkValidator`, `refined`, …); they are gen-types' implementations, not these.

Theory: Findler & Felleisen 2002 (contracts, blame), Chitil 2012 (lazy contracts), Bracha & Cook 1990
(mixins), liquid types (refinement model). Scope graphs are borrowed as vocabulary only.
