---
name: gen-settings
description: Working in gen-settings, the experimental stratified settings resolver (layered fold with provenance, refs-as-data, injection into class content).
type: reference
---

**Status:** experimental and provisional, subject to redesign. Do not build new long-lived dependencies
on it without checking the tracker first.

**Purpose:** stratified settings resolution. It folds a static `{ default; merge }` schema against a
caller-supplied **ordered** layer list (least to most specific) into `{ value; provenance; }`. It adds
refs-as-data (inert cross-aspect references with a static dependency graph) and the injection construct
that hands resolved settings to parametric class content. It is lattice-blind: gen-product derives the
containment chain and gen-scope the name-resolution order that the layer list is built from.

**Depends on:** gen-prelude, gen-algebra (the fold itself, `record.foldLayersTraced`, never
reimplemented), gen-bind (`wrap`, `wrapIdentity`), gen-graph (ref-graph edge derivation and cycle
detection), gen-schema (the declaration datum `mkFieldDeclaration`, and `hashIdentity`), gen-types (schema
field checkers), gen-identity.
**Not its job:** choosing which positions a setting applies to (gen-select), module merge (`evalModules`
is CI-forbidden in `lib/`), class content (gen-class), minting (it never hashes; it reads `id_hash`).

## API (`import ./lib { prelude algebra bind graph schema types identity }`; `import ./. { }` defaults to `ci/flake.lock` pins)

- `mkSchema aspect fields`: field leaves `{ default; merge ? "replace"; }`, `merge ∈ replace append recursive`.
- `mkDeclaration aspectEntry [path]`: a ref to another aspect's setting; `isFieldDeclaration`,
  `fieldDeclarationsIn v` (re-exported from gen-schema). `ref`/`isRef`/`refsIn` are retired throws
  naming their replacements.
- `refGraph batch -> { nodes; edges; cycles; }`, `assertAcyclic`, `renderCycles`.
- `resolveOne { resolveRef ?; strict ? true; } schema layers`; `resolveAll batch -> { value; provenance; graph; }`.
- `injectAspectSettings { settingsKey ?; bindings ?; contracts ?; provenance ?; } { aspect; settings; } classContent -> { module; wrapped; signature; }`; `assembleHost { bindings ? {}; } { class; aspects; } entity`.
- `renderAddress` (display only, never parsed back).
- Shapes: layer `{ scope; rendered; via; value; }`; batch member `{ schema; layers; key ?; strict ?; }`;
  provenance entry `{ scope; rendered; via; refs; value; }`.
- Error codes: E1 schema shape, E2 strict undeclared field, E3 ref cycle, E4 unresolved ref, E5 bad ref
  path, E6 bad declaration target, E7 duplicate batch key or identity, E8 duplicate `settingsKey`, L14
  class/entity identity violation.

## Invariants

- **Order is authority.** The layer list is never sorted, deduped or filtered. There is no
  strength/priority lattice (contrast: CSS cascade, `mkOverride`).
- Refs are applicative dependencies (Build Systems à la Carte §3), so the ref graph is computable before
  any value. `refGraph` is conservative over **pre-fold** values: a ref shadowed by a later `replace`
  layer still contributes an edge.
- A function in a scanned position is **refused**, not skipped, so a declaration inside a function body
  is an error, never an invisible edge. The only escape is a declared schema-level annotation.
- `resolveAll`'s `value`, `provenance` and `graph` all route through one gate, so a consumer gating on
  `.graph` alone cannot pass a batch `.value` refuses. Members are grouped by identity; two members
  sharing an `id_hash` under different keys is a named E7, not a silent collapse to the first.
- Acceptance gate: the resolved value is byte-identical to gen-algebra's `foldLayers`; labels are
  fold-opaque.
- nixpkgs-lib-free (purity test); no hashing in `lib/`.

## Working in it

`nix develop ./ci --command ci` and `--tests-error` (guarded); CI runs `nix flake check` in `ci/`. Perf:
`nix run ./ci#perf-bench` (`PERF_BASELINE_LIB=<incumbent lib/>` to compare). Drift check: `nix eval --json .#lib --apply builtins.attrNames` must equal `builtins.attrNames (import ./default.nix { })`;
the two entries check each other.

## Traps

- A dotted field name is an **eager** E1 (fires on any use); a missing `default` or unknown `merge` is
  per-field lazy. `"semilattice-set"` is E1 here even though the fold implements it.
- `mkDeclaration` validates at application time.
- `isFieldDeclaration` is marker-only: a hand-written marker is counted, then dies on a raw
  missing-attribute error.
- `fieldDeclarationsIn` is structurally strict: any throwing position throws during the scan.
- `resolveOne`'s default `resolveRef` throws E4, so a schema whose default is a ref needs a resolver.
- `strict = false` does not drop an undeclared field; it **passes through** into the value.
- An edge targets only the **head** of a ref path; the tail is edge data.
- Layer labels are needed only when provenance is forced. A bare `{ value; }` layer folds fine and then
  aborts uncatchably when provenance is forced. Cite such failures **by binding**, never by a quoted
  line:column, which drifted across four re-runs.
- `assembleHost` checks class and entity identity even with `aspects = []`. The class scopes the result
  key from outside (`class@attaches:<digest>`); the entity is a relatum of the digest, the class is not.
- `injectAspectSettings`'s `wrapped` is gen-bind's "did I rebind an argument" flag, `false` for content
  declaring no bound argument.
- `renderAddress` truncates `id_hash` to 8 characters.
- A grep predicate must be proven live: `-E 'a\|b'` in ERE searches a literal `\|` and returned nothing
  at every revision while looking like a clean result. A "no hashing" sweep needs a control that fires on
  a known hashing site elsewhere, not just a control that the files are readable.
- A delegated quadratic step can still be cheaper overall; measure with the bench, and never average
  figures from two different instruments.
