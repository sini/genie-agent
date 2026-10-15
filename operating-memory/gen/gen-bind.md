---
name: gen-bind
description: Working in or calling gen-bind — partial application of external bindings into module functions, config thunks, contracts, merge strategies, arg-env crossing primitives, and the boundary-crossing surface.
type: reference
verified: unverified
---

**Purpose:** partial application of external bindings into Nix module functions. It inspects a
module's formals (`builtins.functionArgs`), injects matching bindings, and re-advertises the
residual interface in the nixpkgs `__functionArgs` / `_file` convention. It also owns three
primitives that rewrite the arg environment AT an `evalModules` crossing, and the **boundary
crossing** surface (`crossing`): how a substrate-resolved value enters an evaluation gen does not
own. This is where pure gen values meet the terminal (nixpkgs) plane.

**Depends on / used by:** gen-prelude, gen-algebra. Used by gen-settings, gen-delivery, the hub's
compose route. NOT its job: running `evalModules` (the terminal threads `lib` in; gen-merge is the
pure engine), types (gen-types — gen-bind contracts are runtime predicates), content rewriting
across a delivery edge (gen-view), choosing which module a binding applies to (gen-dispatch),
precedence layering (gen-settings — `compose` here is a plain `//`), class gating (gen-class),
identity minting (the caller supplies the identity string; the crossing takes the mint injected).

## Layout

- `lib/wrap.nix` (`wrap`, `wrapAll`), `lib/thunk.nix`, `lib/contract.nix`, `lib/merge-strategy.nix`,
  `lib/provenance.nix`, `lib/compose.nix`, `lib/identity.nix`, `lib/strip.nix`, `lib/signature.nix`.
- `lib/arg-env.nix` — `adaptArgs`, `crossEval`, `configGate`.
- `lib/crossing.nix` + `lib/crossing-*.nix` — the crossing (`term`, `binding`, `delta`, `adapter`,
  `linkset`, `refusal`, …).
- `lib/module-convention.nix` — `setFunctionArgs` / `setDefaultModuleLocation`, vendored
  byte-for-byte from nixpkgs; not exported.
- `default.nix` — function with one formal `prelude` (defaults to the `ci/flake.lock` pin) plus the
  `wire` seam; no `...`, so an undeclared argument is a loud error.
- `ci/tests/evalmodules-equivalence.nix` drives gen-bind output through real nixpkgs `lib.evalModules`.

## API

- `wrap cfg` → RECORD `{ module; wrapped; validator; signature; advertisedArgs; }` (read `.module`).
  `wrapAll cfg` → `{ modules; validators; signatures; all; }` (`all = modules ++ validators`).
  cfg: `module`/`modules`, `bindings`, `contracts`, `provenance`, `mergeStrategies`,
  `defaultMergeStrategy ? "bind-wins"`, `thunkBindings ? null`, `producerConfigs`.
- Merge strategies: `"bind-wins"`, `"system-wins"`, `"error"`; anything else refused by name when
  `wrap opts` is formed. `mergeStrategy.fromBindings`, `mkMergeValidator`.
- Thunks: `mkThunk fn`, `mkThunkFrom scopeId fn`, `isThunk`, `resolveThunks`. A thunk defers a
  binding value until `config` exists.
- Contracts: `contract.mk { check; message; blame; }`, `hasFields`, `isType`, `nonEmpty` (a value), `apply`.
- `compose` (shallow `//`), `composeWith` (bindings, provenance, contracts, mergeStrategies).
- `wrapIdentity { class, module, identity, isAnon }`, `stripBindingArgs`, `buildSignature`.
- Arg-env: `adaptArgs` (writes `_module.args` visible to siblings), `crossEval` (owns a nested
  `evalModules`; set `specialArgs`), `configGate` (contributes config under `mkIf`).
- Crossing (`crossing.*`): `term.*` (closed first-order body algebra: `lit`, `readFrom`, `readCtx`,
  `ifThenElse`, `attrs`, `list`, `concat`, `pathJoin`, `apply`), `binding.{plain,termed,scoped,wrapped}`,
  `strata`, `demands`, `deltaExact`, `mkOperations { hashIdentity }` → `{ declare; registerSupply; merge; gate; link; close; residue; }`, `mkAdapter`, `placement`, `injectAdapter`,
  `mkHostedTerminal`, `mkOutputsTerminal`, `mkLinkset`, `contractTerm.*`, `isOk`, `isRefusal`.
  Flow: `registerSupply` → `declare` → `link` → `close` with an Adapter.

## Invariants and laws

- **The crossing ships no minting formula and no bound operation.** There is one minting authority;
  a convenience default here would be a second one reachable by simply omitting the injection, and the
  omission would be invisible. `mkOperations` refuses by name without `hashIdentity`. Tests inject a
  clearly named stand-in from fixtures; a scan cell refuses `hashString` in `lib/`.
- **A crossing is a node** (the relation between an import, a binding and a target). Its demand set is
  DERIVED by structural recursion over the closed term algebra, never declared.
- **Substrate placement requires `deltaExact = "EXACT"`.** An APPROX demand set under-approximates, so a
  passing negative-membership check proves nothing.
- **The demand analysis ignores access marks.** A mark narrows the query, never the analysis; the
  earlier cut was fail-open and admitted an unsupported placement.
- **Use `binding.termed`, not `wrapped`, for an analysable body**: `wrapped` under-approximates demand.
- Growing a null-position adapter's offered positions is a design change needing a ruling: it turns
  a by-construction guarantee into an as-authored one with every fixture still green.
- `injectAdapter` is a declared opt-out with its price recorded: its payload carries option-type
  functions, so gen types reach the target's arg env.
- Contracts realise Findler-Felleisen blame through provenance; the crossing's contracts take the
  completeness arm (eager), the opposite of the lazy `contract.nix` contracts.

## Working in it

- `nix develop ./ci --command ci` (guarded); `nix flake check ./ci` is CI's unguarded form.
- Purity scan over `lib/**.nix` + `flake.nix`; the vendored module-convention code is held
  byte-behaviour-identical to nixpkgs by the evalModules-equivalence suite.
- Drift check: `nix eval --json .#lib --apply 'l: builtins.attrNames l.crossing'`. If any of the six
  operation names reappears there, that is a regression, not an addition.

## Traps

- `wrap` returns a RECORD; passing it to `imports` is wrong. Use `.module`.
- A partially applied module is `{ __functor; __functionArgs; }`, not `builtins.isFunction`; nixpkgs'
  `lib.isFunction` accepts it. `stripBindingArgs` on a raw function also returns an attrset.
- `...` is not a formal: `{ ch, ... }` with `ch` bound is FULLY matched and `.module` advertises nothing.
- **Contracts fire when the wrapper is APPLIED**, even if the module never reads the arg: the merge
  policy and thunk detection both force the binding. Only setting both `mergeStrategies.<a>` and
  `thunkBindings` restores laziness.
- Setting `thunkBindings` disables auto-detection; a wrong name leaves real thunks unresolved.
  Auto-detection fires only on LIST-valued bindings; a bare thunk passes through unresolved.
  `resolveThunks` splices list results and wraps scalars.
- A non-string or unregistered producer scope key falls back SILENTLY to the consumer config.
- `signature.declaredMergeStrategies` is the strategy declared at the call, not the effective one;
  runtime precedence is cfg entry, then the binding's `_mergeStrategy`, then the default.
- The merge validator only warns when the bound name is a member of `moduleArgs` or
  `config._module.args`. An `error` strategy throws only when `config.warnings` is forced; the target
  must declare `warnings`.
- `configGate` gates config via `mkIf`, never `imports`. A false gate under a freeform absorber leaves
  the key DECLARED but valueless: reading it throws. `crossEval` with `absorb = false` cannot land opaque keys.
- `compose` is shallow: `compose [ { a.x = 1; } { a.y = 2; } ]` ⇒ `{ a = { y = 2; }; }`.
- `wrapIdentity` with `isAnon = true` emits no `key`. A no-match wrap still advertises the full arg set.
- `crossing.term.lit` FORCES its payload: a throwing field is refused even if never read; every
  derivation is refused (use `wrapped` to place a package); the node budget counts scalars too.
- `crossings` is ordered by identity hash; key by `.name`, never index positionally.
- A merged multi-body fragment refuses at `close` (`close-body-count`) rather than dropping a body.
- `tryEval` does not catch an undefined-variable error; such an arm cannot be a test cell.
- Apply-only intakes accept functor chains up to 32 levels and refuse deeper ones (fail-closed,
  because the door cannot see remaining call depth).

Related: \[[gen-overview]\] \[[gen-delivery]\] \[[gen-retired]\]
