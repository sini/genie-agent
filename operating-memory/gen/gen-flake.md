---
name: gen-flake
description: ARCHIVED library — the former nixpkgs/flake-parts boundary (compose, realize, terminals); read for its successors map and the crossing invariants, never take a new dependency.
type: reference
---

**Status: ORPHANED AS REFERENCE.** The library is dissolved. **Take no new dependency.** Successors:

- compose core → the gen hub's `lib.compose` and interim `flakeModules.default` (interim: the settled
  framework interface arrives later);
- warm / override / trace → gen-memo;
- projection + `realize` → gen-delivery;
- `inject` / `terminals` → the crossing's Adapter set (gen-bind) via the hub;
- `diff.nix` stays here as reference input to gen-memo's failure-attribution work.

**Purpose (historical):** the single nixpkgs / flake-parts boundary of the pure-gen stack.
`compose` resolved a gen module tree purely through gen-merge's `evalModuleTree` into resolved
values, a flat aspect registry, a per-host class projection and a provenance channel; `realize`
folded that projection through per-class terminals into `{ <class>.<host> = artifact; }`.

## Surface as it stood

- `compose { tree; modules; specialArgs; engineArgs; selectHosts; }` → `{ values; aspects; hosts; provenance; override; }`; `composed.override { modules = [ … ]; }` re-composes (warm when possible).
- `injectArgs composed` → `{ _module.args.genValues = composed.values; }`.
- `realize { composed; terminals; bindings; extraModules; }`.
- `terminals.mkSystemTerminal { evaluator }`, `terminals.nixosSystem { nixpkgs }`,
  `terminals.mkFlakeTerminal { inputs; self; modules; systems; }`.
- `flakeModules.default` with `options.gen.{tree, modules, specialArgs, inject, injectPerSystem, nixpkgs, terminals, extraModules, composed, realized}`; sets `flake.nixosConfigurations`.

## Invariants that carry to the successors

- **Gen types never leave the pure eval; only values cross into nixpkgs.** Values (which may carry
  gen TYPE objects as inert data) land in `_module.args`, which nixpkgs does not type-walk, never in
  the consumer's options tree.
- **The pure core may not even NAME nixpkgs**; only the terminal file and the flake module may, and the
  purity scan excludes exactly those by name.
- **Warm is an optimisation, never a semantics change:** an override must be byte-identical to a
  cold compose of the hand-merged arguments, over values AND provenance.
- **The nixpkgs boundary is one call**: a generic terminal over a consumer-supplied evaluator, with
  `nixosSystem` as sugar pinned equal to the generic form by a test.

## Traps (the lessons that drove its successors)

- **Realization on structural shape is wrong.** The class filter tested shape (`? imports` and a
  list), so (a) a declared-but-empty class realized if the aspects layer rendered absence as
  `{ imports = [ ]; }`, and (b) a `channel` or `facet` key whose value carried an `imports` list was
  realized as a delivery class and its terminal CALLED. gen-delivery fixes both by reading the
  declared `keyCategory`. A bare facet never reaches the entry, so a probe using one reads a false absence.
- Silent drops: a host naming an absent aspect, or a dotted path where the registry is SLASH-joined,
  projected nothing with no error. A nested host registry under the default `selectHosts` projected EMPTY.
- Warm detection was syntactic (`attrNames edits == [ "modules" ]`): `override { modules = [ ]; }` was
  "warm" despite editing nothing; both cold cases reported the same reason string.
- The global `bindings` layer splatted wholesale, so a host-named refinement key leaked into every
  other host's bindings.
- A projection entry missing `bindings` failed with a raw attribute error that `tryEval` cannot catch.
- `diff` treated two different functions at one location as unchanged.
- The tree loader skipped any `_`-prefixed file AND directory.
- Host-dependency guards were lazy: a terminal with `nixpkgs = null` constructed fine and threw only
  when an artifact was forced.

## Working in it

Read only. Do not add consumers.

Related: \[[gen-overview]\] \[[gen]\] \[[gen-delivery]\] \[[gen-bind]\]
