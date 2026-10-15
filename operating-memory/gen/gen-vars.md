---
name: gen-vars
description: Working in gen-vars, the frozen, experimental target-agnostic vars/secrets generator algebra.
type: reference
verified: unverified
---

**Status:** frozen and experimental, subject to replacement. Do not build new long-lived dependencies on
it. No repository declares it as a flake input and it is not in the hub roster.

**Purpose:** a target-agnostic vars/secrets algebra. It normalizes generator declarations, orders them
topologically into a backend-agnostic plan, and fans one resolution-free file *handle* out to many
consumer targets in one evaluation. It **emits** a generate script; it never runs it. Its own idea is the
handle/resolver split: a generated file is an open value, and `resolveAll` resolves it per target.
Precedents: nixpkgs/Clan `vars` (the `$in`/`$out`/`$prompts` generator model), agenix-rekey (emit a
runnable artefact, let the consumer drive it).

**Depends on:** nixpkgs `lib` (toposort, module system) for the upper tiers; gen-graph **optional**
(enriches `order/`; falls back to `lib.toposort` + BFS). `pure/` uses `builtins` only.
**Not its job:** running scripts (the consumer's deploy path), selecting which generators a host gets
(gen-scope), injecting values into modules (gen-bind), type checking (gen-types).

## Layout and API

The root `default.nix` is a **function** `{ lib ? null, inputs ? { } }:`; tiers activate by argument.
Flake entry: `inputs.gen-vars.lib`.

| tier                | dir        | exports                                                                                                                                                                                                                                                                                               |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pure (`builtins`)   | `pure/`    | `mkGenerator name spec` (alias `normalizeGenerator`), `validateGenerator g -> [err]` (never throws), `mkHandle { generator; name; secret ? true }`, `handleId h` (`"gen/name"`), `handlesOf g`, `mkResolver`, `resolve`, `resolveAll { <target> = resolver; } handle`, `pure` (namespace of the nine) |
| order (needs `lib`) | `order/`   | `mkPlan gens -> { order; impactOf; depsOf; }`, `depGraph gens -> { edges = id -> [id]; nodes; }`                                                                                                                                                                                                      |
| module (NixOS)      | `module/`  | `generatorsType settings`, `generatorsOption settings` (`settings.fileModule` required), `fileModuleSlot`, `mkOnMachineResolver { fileLocation }`                                                                                                                                                     |
| backend             | `backend/` | `mkScriptText { plan; fileLocation ? "/etc/vars" }`, `backends.onMachine { pkgs; plan; }`, `mkHarness { plan; store; emitApp; resolve; }`                                                                                                                                                             |

Shapes: `handle = { generator; name; secret; }` (no `deploy`). A plan entry has `name dependencies runtimeInputs script files prompts io`, where `files`/`prompts` are **lists** (on the generator they are
attrsets).

## Working in it

- No CI workflow in the repo. Test with `nix flake check ./ci` from the root.
- `examples/multi-target` is a separate flake with its own `ci`; the root check does not cover it. Run it
  separately. `examples/raw-flake` runs only the lib-only path, never the gen-graph enrichment.
- Drift check: `nix eval --json .#lib --apply 'l: builtins.attrNames l'` and compare with the export table.

## Traps

- **A `deploy = false` file makes its generator fail on every re-run.** The presence check tests all
  files, but only `deploy` files are materialized, so run 2 reports "inconsistent state" and exits 1.
  The repo's test checks only the emitted text, not a re-run.
- `import ./.` is a function, not the library. `import ./. { }` (no `lib`) silently yields **only the
  pure tier**: `mkPlan`, `backends`, `mkScriptText` are absent, not throwing.
- `mkGenerator` validates nothing, and **nothing in the library calls `validateGenerator`**. Call it
  yourself.
- `mkPlan` throws on a missing dep or a cycle. But `depsOf`/`impactOf` on an **unknown name return
  `[]`**, so a typo reads as "nothing depends on it". Their order is BFS, not sorted, and `depsOf`
  excludes the queried node.
- `handlesOf` on a raw (unnormalized) spec is a hard error that `tryEval` does not catch.
- The exported `mkScriptText` is already `lib`-applied; the README's `{ lib } -> …` signature is the
  file's, not the export's.
- `mkHarness` drops `plan` from its result.
- `generatorsOption { }` is a hard error despite `fileModuleSlot` having a default.
- The module tier accepts the empty generator name the pure tier rejects (`*` vs `+` regex), producing a
  path like `/etc/vars/secret//f`.
- `depGraph.edges` is a function, so the value is not serializable.
- `pure/` is lib-free by construction, but no test guards that.
- Nix function equality is always false; compare **applied results** when checking that two exports are
  the same function.
