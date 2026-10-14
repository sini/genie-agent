---
name: gen-resolve
description: Working in (or reading) gen-resolve, the RETIRED attribute-grammar equation vocabulary and static attribute schedule (Knuth circularity test, stratum assert).
type: reference
---

**Status: RETIRED.** The repository stays readable as a reference; its obligations moved to named
destinations. The **cold fold** (equations into a sealed context) is now gen-scope's `foldEquations`. The
**warm fold** (`override`, `warmResolve`) is now gen-memo's `warmOverride`/`warmResolve`. What remains
here is the authoring vocabulary and the schedule builder, `_scheduleWith`, which is still the sole
producer of the schedule `foldEquations` takes.

**Purpose:** the authoring vocabulary for semantic equations (`attr`, `nta`, `cascade`, `reference`) and
the static attribute-dependency schedule over their declared reads: the Knuth circularity test and the
N-way stratum assert. Every computation is delegated to a sibling.

**Depends on:** gen-scope, gen-graph, gen-algebra (`record.foldLayersTraced` for `cascade`), gen-bind
(`wrapAll`). nixpkgs-lib-free, enforced by a purity test.

## API (flat; `import ./lib { scope; graph; algebra; bind; }`)

- Equations, each `{ name; kind; compute; readsAttrs; stratum }`:
  `attr { name; kind; compute; readsAttrs; stratum ? null }` (`compute :: self -> id -> value`);
  `nta { name; spawn }` (spawns nodes, stratum `structural`);
  `cascade { name; channel; strata ? {}; combine ? "replace"; acc ? false }` (layered merge along imports);
  `reference { name; select; target ? "includes" }` (nearest binding; `"neededBy"` gathers reverse).
- Schedule: `_scheduleWith { equations; strataOrder ? [ "structural" "resolution" ] }`, `_buildSchedule`.
  Returns `{ attrGraph; condensation; edges; equations; }`.
- Fold (elsewhere): `genScope.foldEquations { scope; parseParent; declaredDependencies; schedule = _scheduleWith { equations = eqs; }; }`. There is no `equations` formal: they are read off the
  schedule, so a caller cannot pair a schedule with equations it was not built from.
- Read: `ctx.eval.facade.get id attr`; deps: `ctx.trace.<id>.deps` (gen-scope's; refuses an unknown id).
- `why ctx { id; attr }` (coarse cross-node provenance), `materialize ctx id`, `materializeAll ctx type`,
  `terminalBind { modules; bindings; }`, `classKey ctx id` (a reuse-narrowing digest, never a proof).

## Invariants

- The schedule analyses **only declared `readsAttrs`**, at attribute-name granularity with no node
  dimension. `compute` is opaque. The evaluator reads whatever `compute` calls. These are two surfaces
  and neither is derived from the other.
- Stratum rule (Statix-style, Apt–Blair–Walker): a rule may read strata at or below its own; a strictly
  later read is the violation. `terminal` is exempt.
- Laziness is the runtime schedule; this library never re-orders thunks.
- Pin a sealed context's shape with an **exact-set** assertion, not a presence check. A presence cell
  stayed green while the context grew from ten to twelve fields and three prose sites went false.

## Working in it

`nix flake check ./ci` from the root (CI uses `working-directory: ci`). Drift check:
`nix eval --json .#lib --apply builtins.attrNames`.

## Traps

- **An undeclared read passes the schedule.** A `compute` reading an attribute missing from
  `readsAttrs` evaluates fine with no edge. An undeclared *mutual* read escapes the circularity test and
  dies with an **uncatchable** stack overflow. An undeclared structural-to-resolution read escapes the
  stratum assert. Declare every read.
- A `readsAttrs` entry naming a non-equation is silently dropped; the eval-time read then throws.
- Name-level analysis rejects a cycle whose per-node instantiation would terminate.
- Cross-node reads have a **second** declaration surface, `declaredEdges` (default `_: []`), which the
  schedule never consults. Under-declaring it serves a **stale** value on a warm re-fold.
- `stratumOf` falls through to `"structural"` for an unknown kind, and `attr { stratum = "nonsense"; }`
  constructs fine; only the schedule rejects it. An explicit `stratum` overrides the kind default.
- `cascade` applies `combine` to **every field**, so a heterogeneous channel under `"append"` dies with an
  uncatchable type error. `"semilattice-set"` needs `acc = true`. `strata` shadows `decls.<channel>`.
- `reference` accepts only `"includes"`/`"neededBy"` targets.
- `why` reports only cross-node pairs and answers `[]` for an unknown attr or node.
- `materialize` and `classKey` hardcode `"output-modules"` / `"resolved-aspects"` and throw without them.
- `classKey` collapses function-valued leaves: two values differing only in a closure digest identically.
  Back any reuse on it with a byte-identity (drvPath) gate.
- `terminalBind` returns more modules than given: it appends the collision validators.
- `tryEval` catches only `throw`/`assert`. Stack overflow, type errors and missing-argument errors kill
  the evaluation; record those as observed process failures.
- A HOAG `spawn` that does not terminate diverges at eval; the gate covers acyclicity only.

Theory: Knuth 1968 (circularity), Vogt–Swierstra–Kuiper 1989 (HOAG `nta`), Neron et al. 2015 (name
resolution strata), Statix §4.3, Hedin 2000 (reference attributes), Sloane 2010 (circular fixpoint).
