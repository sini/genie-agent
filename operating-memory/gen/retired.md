---
name: gen-retired
description: When a pin, a doc or old code names gen-demand, gen-edge, gen-flake, gen-pipe, gen-rebuild or gen-resolve — where each export went, and the lessons from them that still apply.
type: reference
verified: unverified
---

**Status:** all six are off the roster and archived for reference: readable, unmaintained, never a hub
input. **Bind the successor, never these.** Supersedes the six per-library references that stood here
before (gen-demand, gen-edge, gen-flake, gen-pipe, gen-rebuild, gen-resolve).

## Successor map

| archived    | export                                                                         | now                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gen-demand  | `mkKind`, `mkKinds`, `demand`, `resolveAll`, `folds`                           | gen-scope: `lib/cascade.nix` + `lib/folds.nix` under claim vocabulary (`mkClaim`, `resolveClaims`)                                                                    |
| gen-demand  | `adapters`                                                                     | retired without moving                                                                                                                                                |
| gen-edge    | `edge` (S/T)                                                                   | gen-view `viewDefinition.root` / `.direction` / `.admission` / `.channel`                                                                                             |
| gen-edge    | `edge` (P/M), `modes`, `setAttrByPath`                                         | gen-view `placement.place`, `placement.modes`, `placement.setAttrByPath`                                                                                              |
| gen-edge    | `defaultFold`                                                                  | `compositions.movement` + `placement.place { mode = "merge"; path = [ ]; }`                                                                                           |
| gen-edge    | `sources.collected` / `value` / `keyedValue`                                   | `readsOf`; the authored `scopeGraph { data }`                                                                                                                         |
| gen-edge    | `targets.root` / `.output`                                                     | `placement.targets.root` / `.output`                                                                                                                                  |
| gen-edge    | `edgesFor`, `toposort`                                                         | `viewDefinition.root` → `viewRelation.contributions`; `accumulatorRelation` + `accumulatorOrder`                                                                      |
| gen-edge    | `readsOf` / `writesOf`                                                         | same names in gen-view, on the MATERIALIZED result; `writesOf` takes the placement                                                                                    |
| gen-edge    | `project`                                                                      | dial by dial: `relationLookup`, `dedups`, `viewRelation` marks → `boundedBy`, `scopeGraph.scopes`                                                                     |
| gen-edge    | `materialize`, `adapt`, `combine.merge`                                        | `viewRelation.value` + `placement.place` or `orderedFoldOf`; `transform.map`; `combines`                                                                              |
| gen-edge    | `sources.synthesize`, `sources.rewalk`, `project.classInject`                  | HELD: no destination                                                                                                                                                  |
| gen-flake   | `compose` core                                                                 | the hub's `lib.compose` and interim `flakeModules.default`                                                                                                            |
| gen-flake   | warm / `override` / trace; `diff.nix`                                          | gen-memo (`diff.nix` stays as reference input to failure attribution)                                                                                                 |
| gen-flake   | projection + `realize`                                                         | gen-delivery                                                                                                                                                          |
| gen-flake   | `inject` / `terminals`                                                         | the crossing's Adapter set (gen-bind) via the hub                                                                                                                     |
| gen-pipe    | `channel map filter fold scan over route tee compose run provenanceOf traceOf` | gen-view, same-named constructs                                                                                                                                       |
| gen-pipe    | `sel`                                                                          | gen-select directly                                                                                                                                                   |
| gen-pipe    | `join`; `consume`; `contribute`, `deferred`                                    | caller-side composition; split; HELD                                                                                                                                  |
| gen-rebuild | all 24 exports                                                                 | gen-memo (a strict superset)                                                                                                                                          |
| gen-resolve | cold fold                                                                      | gen-scope `foldEquations`                                                                                                                                             |
| gen-resolve | `override`, `warmResolve`                                                      | gen-memo `warmOverride` / `warmResolve`                                                                                                                               |
| gen-resolve | `attr`, `nta`, `cascade`, `reference`, `_scheduleWith`                         | NOT MOVED: `_scheduleWith` is still the sole producer of the schedule `foldEquations` takes, so a caller of the cold fold still reads it from the archived repository |

## Lessons that still apply

- **Retire by marking, not cutting.** Mark each export with its destination; keep every export
  evaluating and the validating instrument runnable until the acceptance has run. "Serviced elsewhere"
  is the only ground for removal; a caller count is not one. A drift check proves the retirement moved
  documentation, not surface: the pinned export list diffs clean and a one-token mutant goes red.
- **A topology fingerprint is not acceptance authority.** Two executions with different answers shared a
  byte-equal edge-trace hash. Acceptance is end-result equivalence.
- **Realize on the declared category, never on structural shape.** gen-flake's `? imports` filter
  realized empty classes and called a terminal on a `channel` key; gen-delivery reads `keyCategory`.
- **Warm is an optimisation, never a semantics change:** a warm override must be byte-identical to a
  cold run over values AND provenance. Syntactic warm detection (`override { modules = [ ]; }` counted
  as warm) is a defect.
- **Gen types never leave the pure eval; only values cross into nixpkgs** (via `_module.args`), and the
  pure core may not even name nixpkgs.
- **Declare every read.** An undeclared read passes a static schedule; an undeclared mutual read
  escapes the circularity test and dies with an uncatchable stack overflow; under-declared cross-node
  edges serve a stale value on a warm re-fold. Still live wherever `_scheduleWith` is used.
- **Divergence is guarded structurally, never by catching:** `tryEval` catches only `throw`/`assert`,
  not a black hole, a stack overflow, a type error or `toJSON` on a function.
- **Merge order shadows definitions:** a `//` fold of files lets a later file's export silently replace
  an earlier one's.
- **Measure combinator cost** with `NIX_SHOW_STATS` (`nrFunctionCalls`) over a growing input:
  gen-pipe's `compose` was cubic in channel count.
- **Error precedence follows force order**, and a null identity makes selectors silently false
  (`sel.not (sel.entity …)` keeps it). Throw on a missing identity.
- Pin a sealed context's shape with an **exact-set** assertion, not a presence check.
- Run documentation snippets; do not trust a README's stated output order.
- Do not attribute a library's own property to the paper it cites.

Related: \[[gen-overview]\] \[[gen-scope]\] \[[gen-view]\] \[[gen-memo]\] \[[gen-delivery]\]
