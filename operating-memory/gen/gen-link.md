---
name: gen-link
description: Working in gen-link, cross-flake aspect federation (normalize, origin-stamp, disjoint union, facet wiring, resolution manifest).
type: reference
---

**Purpose:** federate aspect registries from several flakes into one graph.
`link { wire ? {}; } sources` normalizes each registry into an origin-free includes-graph, stamps every
node with a federation ORIGIN, disjoint-unions the subgraphs, mints every merged node's identity through
gen-scope's staged minting entry (each facet filling is a relatum), and returns a diffable resolution
manifest. gen-link owns only the origin coordinate, the union-with-relabel and the manifest; it delegates
every computation to a sibling. A node is NAMED by its identifier (`"b/apps/app"`, origin-qualified);
its IDENTITY is a derived content address carried as a field. gen-link mints nothing.

**Depends on / used by:** root inputs gen-prelude, gen-scope, gen-view, gen-schema, gen-algebra,
gen-aspects (gen-merge only in `ci/`). Used by the hub (re-exported as `link`) and `examples/demo`.
Not its job: minting (gen-scope `mintStrata`, gen-schema), aspect payload and keys (gen-aspects),
edge resolution (gen-view `referenceResolution`), materialization (gen-view), record algebra
(gen-algebra), building registries (gen-merge), graph queries (gen-graph), domain vocabulary (every facet
and class key arrives per source in `keySemantics`), writing a lock file (the consumer does).

**Future grammar (ruled, not built):** federated references will be kind-qualified,
`namespace.<kind>.name`, so cross-kind collisions are inexpressible. Today ships the two-segment
origin-qualified form; do not take it as settled.

**Layout (`lib/`):** `ref.nix` (parseRef, origins), `normalize.nix`, `rewrite.nix` (originStamp/alias),
`union.nix`, `facets.nix`, `contract.nix`, `manifest.nix`, `link.nix` (the conductor). Root `default.nix`
is a function, `import ./gen-link { }`, with formals `prelude scope view schema algebra aspects`
defaulting to lock pins.

**API:**

- `parseRef : ref -> { __keyRef; origin; path; key }` (`self` => origin `[]`).
  `renderOrigin` (`[]` => `"self"`, the live one) and `originLabel` (`[]` => `""`).
- `normalize : registry -> { nodesByKey; edges; refByToken }`;
  `originStamp { alias ? {} } origin normalized`; `disjointUnion [ ... ]`.
- Facets: `holesOf ks node`, `providesOf ks node`, `requiresOf node facet`, `contractOf ks facet`,
  `checkCapability edgeName requires provides`, `checkRefined edgeName refinedType value`.
- Manifest: `entry { via ? null } { kind, from, fromKind, to, toKind }` (`kind` in `includes|hole`); `order`.
- `link { wire ? {} } sources -> { graph; manifest; nodes; bound; resolved }`. Each source is
  `{ registry; keySemantics; origin ? []; alias ? {}; }`. `keySemantics` has NO default (write `{ }` for none).
  `wire = { "<requirerRef>" = { <facet> = "<fillerRef>"; }; }`.
- No identity export exists. Write an identifier as `"${renderOrigin origin}/${key}"`.
  Read an identity from `(link ...).nodes."<id>".identity`.
- Public despite underscores: `_scaffold`, `_hasRefPrefix`, `_recordHas`.

**Invariants and laws:**

- Options first in one closed set, subject last; unknown options are refused by name when `f opts` is formed.
- Instantiation is APPLICATIVE: the same fillings give the same identity (a filling is a relatum, and
  identity is a total function of kind, identifier and resolved relata). A filling is a REFERENCE, never a closure.
- A minting pass is a stratum, closed before the next, so a cycle among minted nodes is unwritable.
- The completeness (unwired hole) guard is `deepSeq`ed into EVERY returned field, not just `.manifest`.
- A `wire` key naming no declared hole on the requirer is refused by name. Before that guard existed it
  forked identities on undeclared names.
- The manifest records IDENTIFIERS, never identities, so nothing durable rests on internal addressing.
- nixpkgs-lib-free (purity scan for `nixpkgs`, `lib.`, `{ lib }`, `evalModules`, `mkOption`).
- Fixtures thread ONE gen-schema instance through gen-aspects and gen-scope. Two instances put two
  content-address formulas in one evaluation, and declared holes then read as unwired.

**Working in it:** `nix develop ./ci --command ci` and `... ci --tests-error` (guarded);
`nix flake check ./ci` (what CI runs, unguarded); `nix fmt -- --ci`. REPL: `nix repl ./ci/repl.nix`.
Drift: `nix eval --json .#lib --apply builtins.attrNames`. `ci/tests/conductor-oracle.nix` runs the real
siblings in one chain, so a stubbed sibling breaks it.

**Traps:**

- A refusal surfaces only to a consumer that REACHES THE MINT. On a filling cycle, `attrNames .nodes` and
  `deepSeq .graph` succeed; reading any `identity` or `.manifest` fails.
- A node with no `includes` gets no `resolved` entry (absent, not `null`).
- The identifier is the declared path (`meta.loc`); overriding `.key` or `name` does nothing.
- Two sources with the SAME origin silently collapse same-key nodes (last wins).
- `parseRef "self"` yields an empty key, not an error; `self` is special only in first position.
- `contractOf` answers `"capability"` for any key, even non-facets; never throws.
- A facet key declared without `.option` keeps the hole but adds a phantom node.
- `alias` rewrites only the aliasing source's keys; an inbound reference to the old path fails at manifest time.
- `checkCapability` with empty `requires` passes against empty `provides`.
- `includes` rows always have `via = null`; only `hole` rows name a facet.
- An anonymous inline `includes` entry is refused by name. Before that refusal it left a dangling edge
  that crashed uncatchably.
- "channel" here means a keySemantics channel, not a gen-view dataflow channel.
