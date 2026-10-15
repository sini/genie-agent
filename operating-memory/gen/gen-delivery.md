---
name: gen-delivery
description: Working in or calling gen-delivery — projecting declared delivery classes per node and folding each class's content into its terminal (project / realize), with the class-discipline refusals.
type: reference
verified: unverified
---

**Purpose:** the delivery-class realization surface. `project` discovers, per node, which aspect
keys are DECLARED delivery classes and collects their content; `realize` folds each class's content
into the terminal that owns that class (for example a `nixos` terminal calling
`nixpkgs.lib.nixosSystem`). The projection and the fold are ONE construct: the realization predicate
lives in the first half and the fold that trusts it in the second, so `lib/default.nix` is one file.
This is the crossing from the pure plane to the terminal plane; `realize` itself stays pure, and the
nixpkgs contact lives in the terminals it is handed.

**Depends on / used by:** gen-algebra, gen-aspects, gen-prelude, gen-scope, injected (declared but
unapplied root inputs). Framework stratum. Used by the hub's interim `flakeModules.default`.

## API

`{ algebra, aspects, prelude, scope }` in; `{ project, realize, defaultLayerOrder }` out.

- `project { selectNodes ? null; deliveryClasses ? {}; instances ? {}; } cnf values` →
  `{ aspects; nodes; }`. Options first and closed; `cnf` required (`null` refused by name).
  `deliveryClasses.<node>.<authored class> = <delivery class>` readdresses a class at a node;
  `instances` is gen-aspects' `instancesFor` relation.
  `nodes.<node> = { bindings = { node = <instance>; }; classes.<delivery class> = [ deferredModule ]; }`.
  `aspects` is the flat registry.
- `realize { bindings; refinements; layerOrder ? defaultLayerOrder; extraModules; } terminals projected`
  → `{ <class>.<node> = artifact; }`.
- `defaultLayerOrder = [ "projection" "global" "refinement" ]`.

## Invariants and laws

- **Realize only DECLARED content, never structural shape.** Only keys whose gen-aspects
  `keyCategory` is `"class"` realize; a `channel` key rides verbatim. A key that merely carries an
  `imports` list is not a class.
- **Two refusals, deliberately not one:** a missing `cnf` (no category source) REFUSES BY NAME at
  the projection root; a key whose category is `null` or not `"class"` is simply not a delivery class,
  with no refusal. `keyCategory` returns `null` for undeclared keys by contract, and undeclared keys
  are ordinary nested aspects; the surface refuses on its own missing input, never adjudicates
  someone else's key.
- **Root-forced refusals.** The `cnf` and `layerOrder` checks are forced by `seq` at the root, not
  where the predicate reads them. A lazy refusal fires on the SIZE of the input (a registry with no
  members never reaches the predicate), so a small fixture reads clean.
- **`layerOrder` is total**: naming an unknown layer refuses, and so does omitting a declared one,
  because an omitted layer is a deleted contribution, not a shorter list.
- **Class discipline.** `extraModules` is CLASS-MAJOR (`{ <class>.<node> = [ module ]; }`); a
  terminal receives only what is addressed to its class at its node. Extras supplement a realization
  and never create one. Every address must be a realization point or it refuses by name:
  R0 `extraModules.<c>` not an attrset; R1 non-empty `extraModules.<c>` with no `terminals.<c>`;
  R2 no such node; R3 the class does not realize at that node; R4 declared content for a class with no
  terminal (refused rather than silently dropped from a fold that iterates `terminals`).
- No crossing is implicit. An explicit crossing lands only at its address. Adapter matching is not
  performed: the inlet cannot tell adapted from un-adapted content.
- **Domain restriction:** never derive the address set or the projection from `realize`'s own output.
  The total check must read every address first, so self-derivation diverges with uncatchable
  infinite recursion. Derive addresses from the projection, and the projection from the values.

## Working in it

- `nix develop ./ci --command ci` and `nix develop ./ci --command ci --tests-error`. Unguarded:
  `nix-unit --flake ./ci#tests`, `nix-unit --flake ./ci#testsError`.
- Suites: `declared-content` (through a real gen-aspects schema), `realization-predicate` (a
  hand-built registry), `carriage`, `contribution-order`, `class-discipline`, `extent`,
  `class-content`, `purity`, `doors` (goldens in `ci/tests-error.nix`).
- Format: `cd ci && nix fmt -- --ci`. It fails on change AFTER writing it: re-run and read `0 changed`.
- Read exit status unpiped (zsh: `$pipestatus`). Count aborted cells as failures. `0/0` is a false pass.
- Drift check must apply a substrate (the lib output is a lambda):
  `nix eval --json --impure --expr 'let ci = builtins.getFlake (toString ./ci); in builtins.attrNames (import ./lib { algebra = ci.inputs.gen-algebra.lib; aspects = ci.inputs.gen-aspects.lib; prelude = ci.inputs.gen-aspects.inputs.gen-prelude.lib; scope = ci.inputs.gen-scope.lib; })'`.

## Traps

- **`deepSeq` does not evaluate a class body**: the value is `{ imports = [ { _file; imports = [ <lambda> ]; } ]; }`
  and a lambda is already WHNF. A laziness test must APPLY the body.
- A bare facet declaration (no `option` / `module`) never reaches the entry, so a probe using it
  reads a false absence.
- import-tree skips any file whose basename starts with `_`; a `_x.nix` cell is collected by nothing.
- `checks.default` cannot host an `expectedError` cell; a throwing cell crashes the gate. Put it on
  `testsError`.
- Class content is detected by gen-aspects' `hasClassContent` over the whole key set; consume it,
  never re-derive it.
- **Test renames at the SITE, not by token.** A token-scoped check goes green by renaming correct
  uses elsewhere. Pair a correct adapter with a wrongly-renamed one so the two differ observably.

Related: \[[gen-overview]\] \[[gen-aspects]\] \[[gen-bind]\] \[[gen-retired]\]
