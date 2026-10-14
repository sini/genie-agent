---
name: gen-aspects
description: Working in or calling gen-aspects — aspect composition types, aspect identity, key classification, the first-order guard vocabulary, graphFacts and the instance relation.
type: reference
---

**Purpose:** aspect-oriented composition types for the pure module system. One flat option type
(`aspectType`) dispatches by value shape in merge; every aspect gets a path-derived identity
(`key`, `id_hash`); one declared-key classification surface (`keyCategory` over class / channel /
facet); a defunctionalized guard vocabulary; and the aspect graph's facts as plain data
(`graphFacts`) for downstream graph queries. Aspects are the nodes of the configuration graph.

**Depends on / used by:** prelude, merge (every option and type is built through the injected
`merge`), schema (`mkSchemaOption` only), identity (the mint, injected). Used by gen-link (resolves
`__keyRef`), gen-class, gen-delivery, gen-rules, gen-program, frameworks.
NOT its job: the module system (gen-merge), leaf types (gen-types), resolving cross-origin
references (gen-link), selection (gen-select), conflict resolution (gen-dispatch), graph queries
over its facts (gen-graph), class-share machinery (gen-class), dataflow channels (gen-view — a
`channel`-category key here is a raw passthrough option, not a dataflow channel), and DRIVING the
guard channel (gen-graph's `expandPreorder`).

## Layout

- `lib/types.nix` — `aspectType`, `aspectSubmodule`, `aspectsType`, `aspectsRoot`, `aspectOrFn`,
  `keyCategory`, `aspectId`, includes element type, closed-key gate.
- `lib/identity.nix` — `key`, `guardKey`, `pathKey`/`parsePath`, `keyRef`.
- `lib/guard.nix`, `lib/guard-term.nix` — guard vocabulary, lifting a body to a term, firing.
- `lib/walk.nix`, `lib/flatten.nix`, `lib/facts.nix` — the walk `flatten` and `graphFacts` share.
- `lib/instance.nix` — `instanceOf`, `instancesFor` (the instance relation).
- `lib/schema.nix` — `mkAspectSchema`, the gen-schema bridge. `lib/cnf.nix` — cnf defaults.
- `default.nix` — `{ prelude, merge, schema, identity }`, each defaulting to a `fetchTree` from
  `ci/flake.lock`, so `import ./. { }` self-constructs. The `wire` formal publishes the shim's
  input map and its `follows` resolver outward.

## API

- Types (each `cnf -> optionType`): `aspectType`, `aspectSubmodule`, `aspectsType`, `aspectsRoot`, `aspectOrFn`.
- Schema bridge: `mkAspectSchema cnf` → `{ schemaOption, mkAspectOption, mkAspectModule, mkNamespaceType, keyCategory, identity, … }`. Use `mkAspectModule { }` to declare aspects in a
  module (it injects schema extensions); `mkAspectOption` does not.
- Identity: `aspectId originSeg aspect` (content address via gen-identity over `[origin, path|key]`;
  `description` is not in the preimage), `key`, `guardKey` (`guard:<64 hex>`), `aspectPath`,
  `pathKey` (injective, escapes `%` and `/`), `parsePath`, `keyRef "origin/a/b"`.
- Classification: `keyCategory cnf key` → `"structural" | "class" | "channel" | "facet" | null`;
  `structuralKeys` = `name description key id_hash meta includes`.
- Guards: `guard condition body`; `pred.{class,tagEq,eq,has,all,any,always,not}`;
  `mkGuardVocab cnf` → `{ pred, guard, fires, vocab, applyGuard, applyGuardWith, applyGuardScoped }`;
  `vocab.{whenClass,whenTagEq,whenEq,whenAll,whenAny,always}`.
- Graph facts: `graphFacts cnf aspects` → `{ nodes; parentOf; includeSitesOf; includesOf; foreignIncludesOf; unresolvedIncludesOf; nodeIdOf; nodeData; deliversOf; deadNested; }`.
  `flatten aspects` → `{ "<path>" = aspect; }`. `isGuardLeaf`.
- Instances: `instanceOf cnf { scope } { aspect, context, sources } value` → `{ id, entry, formals, scope }`;
  `instancesFor cnf aspects { suppliers; containment; } scopes` → `{ vertices; instantiates; reaches; nestedAt; declined; }`.
- Introspection: `canTake.{atLeast,upTo}`, `mkIsModuleFn cnf fn`.
- `cnf` keys (closed set, unknown key refused by name): `keySemantics.<k>.category`,
  `aspectModules`, `metaModules`, `moduleArgs`, `providerPrefix`, `collections`, `closedKeys`,
  `recursiveClosed`, `rejectBareModuleInclude`, `freeformKeys`, `entityKinds`, `ref` (the
  framework's door). A class is a `keySemantics` entry with `category = "class"`.

## Invariants and laws

- **Guards are first-order terms** (defunctionalization, Reynolds / Danvy-Nielsen): condition and
  body are terms of gen-algebra's one algebra. A custom condition is a Nix function that BUILDS a term
  at declaration. A context closure (`{ host, ... }: …`) cannot be defunctionalized in pure Nix: it
  is refused by name here and crosses the gen-rules door.
- **Firing grows the tree by exactly one level.** `applyGuard` fires once, never recursively; a
  self-including aspect is inert here and lethal to a caller that loops. The bound is the driver's.
- **`parentOf` is the WALK position, never a `meta` read.** A nested guard leaf has no
  `meta.aspect-chain`, so `meta.aspect-chain or [ ]` misreads it as root; a guard carried from another
  tree keeps a wrong `meta.loc`. `flatten`'s key is a RENDERING; never split it to recover parents.
- **`includesOf` carries only CHECKED edges** (every target is in `nodes`). A foreign keyRef is a
  reference, published in `foreignIncludesOf` for the provider-unioning framework to resolve.
- **Include elements dispatch on whether they NAME A NODE, not on shape.** Shape dispatch minted
  phantom ids that gen-graph then admitted as nodes. Key-less attrsets are content; guards and
  functions are sealed; an unnamed inline aspect literal is an anonymous node keyed by its declaration address.
- **A reserved key is an option declared through `cnf.aspectModules`**; there is no `reservedKeys` surface.
- **Source doors decide by graph membership (exact id), never by kind tag**: a framework names its
  own entity kinds, even ones spelled like gen's own tags.
- `instanceOf`'s id reads only the sources; the caller must ensure each source supplies the value the
  context carries, or one id gets two entries.

## Working in it

- `nix develop ./ci --command ci` and `nix develop ./ci --command ci --tests-error`.
- Value tests in `ci/tests/<area>.nix`; refusal cells by group in `ci/tests-error.nix`.
- Cite `lib/` by BINDING NAME, never line range: a drifted range lands plausibly on a neighbour and a
  reader closes a live finding against it; a stale name fails loudly on grep.
- Purity scan (`ci/tests/purity.nix`) covers `lib/`, `flake.nix`, `default.nix`; `ci/` is exempt.

## Traps

- `aspectType.check` is `_: true`; every decision happens in merge.
- A guard defined twice at one key merges to a fragment carrier (`fragments = [ … ]`), discharged at firing.
  Multi-def primitives go through `mergeDefaultOption`: agreeing defs resolve, differing ones refuse.
- `keySemantics` category validation is lazy per key: a bad category refuses only where that key is read.
- A non-firing guard yields `null`, not `{ }`. `pred.all [ ]` is true, `pred.any [ ]` false.
- A function as an `eq` value builds, then refuses at the check; a path value makes the guard unmintable.
- Functor-form module functions at an aspect position are refused by name; write a lambda
  `{ config, ... }: { … }` instead.
- `aspectsRoot` drops the mount segment: `aspects.hardware.cpu` keys as `hardware/cpu`.
- `keyRef "prov/a/b"` takes the FIRST segment as origin; `.key` is `a/b`.
- `freeformKeys` opens an ungated subtree under `closedKeys`; `recursiveClosed` keeps the gate down and
  admits only namespace attrsets.
- A bare `{ imports = [ … ]; }` include is accepted unless `rejectBareModuleInclude`.
- `canTake.upTo` rejects a `{ ... }:`-only function, so such an aspect is classed as a guard fn.
- A `channel` key defaults to `null`; a `class` key reads back as `{ imports = [ … ]; }`.
- `keyCategory` returns `null` for an unknown key, so a typo looks like a freeform child unless closed.
- Redeclaring a container over two cnfs concatenates `aspectModules`: one module imported twice.
- `graphFacts` warns (`builtins.warn`) once per force for a dead nested node not in `freeformKeys`;
  with `abort-on-warn` that is fatal.
- The walk (`collectEntries`) has no depth bound: a cyclic aspect tree aborts with an UNCATCHABLE stack
  overflow. This is a declared exception: no pure-Nix predicate separates a cycle from a legitimately
  deep tree. Cycles, not depth, are the practical hazard (real trees are 3-4 deep).

Related: \[[gen-overview]\] \[[gen-algebra]\] \[[gen-class]\] \[[gen-delivery]\]
