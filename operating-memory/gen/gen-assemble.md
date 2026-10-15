---
name: gen-assemble
description: Working in or calling gen-assemble — the shared framework toolkit (contribution protocol, union, id convention, structural declarations) and its membership criterion.
type: reference
verified: unverified
---

**Purpose:** the shared framework toolkit. It holds, once, the protocol every framework wraps
around the one call that builds a node set from many layers' contributions: the union, the
identifier convention, and the structural declarations the evaluator demands. Framework stratum:
it sits above the stack, and nothing in the substrate is defined in its terms.

**Depends on / used by:** a FUNCTION of the injected substrate `{ prelude, scope, algebra }`; it
declares no flake inputs and ships no root `flake.lock`. The hub binds it by construction. Used by
frameworks that assemble a graph.
NOT its job: evaluating anything (gen-scope), identity minting (gen-identity/gen-schema — the id
convention here is ADDRESSING, not identity), the union monoid itself (gen-scope's `overlays`), the
layered fold (gen-algebra's `foldLayers`), traversal (gen-graph), and the contribution DIMENSION or
the computation over it (the caller's).

## Membership criterion (the anti-junk-drawer rule)

A construct belongs here iff ALL hold:

1. EVERY framework that assembles a graph would otherwise write it.
2. Nothing in the substrate is defined in its terms (direction of dependence runs one way).
3. It does not EVALUATE.

Limb 2 was once unenforced and checked only by reading; a green CI is no evidence for it. A canned
host/env graph fails limb 1 and is refused.

**The construction error to avoid:** treating graph SHAPE and CONTENT as one operation. Shape
combines by a commutative, associative, idempotent union (Mokhov's graph monoid) and must not depend
on arrival order. Content arrives as an ORDERED contribution list and folds by positional authority,
with the order a parameter of the assembly, never derived from a global → class → host → user kind
hierarchy. One careless attrset merge collapses the two.

## Layout

- `lib/default.nix` — function of the substrate, returning the nine exports.
- `lib/contribute.nix` — contribution record (`contributionKeys`), `union`, the declared-membership refusal.
- `lib/preconditions.nix` — substrate property probes.
- `ci/tests/surface.nix` — exact-surface tripwire that also parses this library's AGENTS.md drift block.
- `ci/repl.nix` — resolves the substrate once; the drift check applies through it.

## API (exactly nine names)

- `assemble { kinds?; strategies?; strict?; } contributions` → the substrate's `{ nodes, nodeOrder }`,
  bound through the precondition check.
- `union { strategies?; } contributions` — the union alone; where order-independence is observable
  and where the protocol's refusals sit.
- `reserved` — the substrate-privileged labels (`P` parent, `I` import) and their relations.
- `mkId "host" "web1"` ⇒ `"host:web1"`; `parseId` (refuses a bare name or an empty half); `idsOf "host" [ … ]` (keeps the caller's order); `separator` (`":"`).
- `structuralDecls nodes` → the `children` / `imports` bodies the evaluator reads, nested so no flat
  name means two things.
- `substratePreconditions` — the depended-on substrate properties as data `{ record; property; met; }`.

Contributions are TOTAL over seven keys (`contributionKeys`); an unknown key refuses by name.

- `vertices` is the ONLY declaration that a node exists (set union). An id a graph merely mentions
  must be backed by some layer's `vertices`.
- `types` (per-node kind FACT) rides the contribution; `kinds` (the kind REGISTRY, with its ranking)
  is a parameter of the CALL, one per assembly. Putting `kinds` on a contribution is refused.

## Invariants

- **Declared-membership refusal, over all three channels** the constructor reads: edge endpoints
  (`P`, `I`, every `edgeGraphs` label), isolated graph vertices, and content keys (`decls`, `types`).
  Each channel was measured admitting an undeclared node on a green run before it was closed; each is
  armed in CI by a seed that fires it alone. It does not ride `strict`.
- **Preconditions are property probes, not version comparisons.** An assembly over a substrate
  failing one refuses by name rather than serving a wrong answer (two of the original substrate
  defects failed silently).
- Cost is derived, not measured: the union is O(n·V + n·E), paid once at assembly.

## Working in it

- `nix develop ./ci --command ci` (guarded); `nix develop ./ci --command ci purity` for one suite.
  `nix flake check ./ci` is what CI runs (unguarded). REPL: `nix repl --impure --file ci/repl.nix`.
- Format: `cd ci && nix fmt -- --ci`.
- Add an export: write it in `lib/`, then update `ci/tests/surface.nix`, AGENTS.md's Exports table and
  Drift check block; the surface cells fail until all agree.
- Drift check: `nix eval --json --impure --file ci/repl.nix --apply 'r: builtins.attrNames r.genAssemble'`.

## Traps

- **A global gitignore may ignore `AGENTS.md` and `.envrc`.** Plain `git add` silently stages
  nothing; use `git add -f` on the first add. Diagnose with `git check-ignore -v --no-index <files>`:
  WITHOUT `--no-index` it skips tracked paths and goes quiet on the file you just confirmed.
- **nix-unit only collects `test-*` cells.** Lose the prefix and the cell vanishes, count drops, run
  stays green. Reconcile declared vs collected both ways:
  `grep -rhoE '\btest-[A-Za-z0-9-]+' ci/tests/ | sort -u` vs
  `nix-unit --flake ./ci#tests | grep -oE 'test-[A-Za-z0-9-]+' | sort`, then `comm -23` and `comm -13`.
  The class must include capitals (lowercase-only truncates camelCase names and collapses distinct
  cells); `sort -u` the declared side because comments mention cell names too.
- **An untracked file under `ci/tests/` is invisible**, even a deliberately failing one. `git add` first.
- `nix flake check` and nix-unit are different oracles; neither can assert that a throw happened
  (nix-unit's `expectedError` is unassertable). Put refusal cells in the error plane.
- A bare-leaf nix-unit target reports `0/0`, a false pass. Give every absence claim a positive control.
- The purity scan is armed by a planted-tether control cell; an empty `lib/` would otherwise report clean.
- `nix develop ./ci` writes `.git/hooks/pre-commit` and `.pre-commit-config.yaml`; the latter is
  gitignored. Do not stage it.
- `nix eval --expr 'import ./lib'` aborts in pure mode (relative path becomes absolute), and
  `--file lib --apply` dies once `lib` is a function of its substrate. Apply through `ci/repl.nix`.
- `nix fmt -- --ci` from a linked worktree may format the MAIN checkout and report green. Check `git status` in the tree you meant.

Related: \[[gen-overview]\] \[[gen-delivery]\] \[[gen-algebra]\]
