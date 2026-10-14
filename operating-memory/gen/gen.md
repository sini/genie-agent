---
name: gen
description: Working in the gen hub repository — the roster (mkGenLibs), stratum buckets, flakeModules and the hub's CI gate.
type: reference
---

**Purpose:** the ecosystem hub. It owns no concern. It publishes the roster (`mkGenLibs`), the
four stratum buckets cut from it, and flake-parts modules (`genLibs`, and the interim
`default` compose→realize entry). Read \[[gen-overview]\] for the roster and layering.

**Depends on / used by:** pins every roster member as a root flake input. Consumed by den, by
gen-demo, and by any consumer wanting the whole roster. It does NOT ship `mkCi`: that is
`gen-harness.lib.mkCi`, which pins no gen library, so a sibling's `ci/` lock does not drag the hub.

## Layout

- `lib/mkGenLibs.nix` — stage 1: one named formal per member (each arrives RESOLVED), `inherit`s
  them all, plus the `strata` declaration. No per-member construction.
- `flake.nix` — stage 2: `mkGenLibs = _: roster` (the argument is vestigial); the buckets; `flakeModules`.
- `flakeModules/genLibs.nix` — sets `_module.args` for eight keys: `genAlgebra genAspects genBind genDispatch genGraph genSchema genScope genSelect`.
- `ci/` — the real gate: `mkgenlibs-eval.nix` (roster tripwires), `direction-of-dependence.nix`
  (refuses upward strata edges), `agents-md-hub-inputs.nix` (binds AGENTS.md blocks), the den
  parity oracle, perf-bench, fleet-consistency.
- `ARCHITECTURE.md` (DAG, roles, constraints), `TERMINOLOGY.md` (vocabulary with provenance),
  `TRUST.md` / `VALIDATION.md` (every proof, its command, its failure mode), `BENCHMARKS.md`.

## API

- `lib.mkGenLibs { }` → the flat roster (unprefixed keys) plus `strata`.
- `lib.substrate` / `lib.modules` / `lib.aspects` / `lib.framework` → selections from the flat
  roster, never re-imports, so `lib.substrate.prelude` and the flat `prelude` are ONE value.
- `(lib.mkGenLibs { }).strata.<key>` → the member's layer; pure data, forceable with no member resolved.
- `flakeModules.genLibs` is a PATH, not a module value.
- Three names per library: flake input `gen-schema`, roster key `schema`, module arg `genSchema`.
- `lib.aspects` is the S3 bucket; `lib.aspects.aspects` is the gen-aspects library. Both resolve.

## Invariants

- **`strata` is total and explicit.** No default bucket, so a new library cannot land silently in
  one. Adding a member = binding + stratum line in the same commit.
- **Direction of dependence:** edges only run down `substrate < modules < aspects < framework`.
  Packaging separation did not prevent an upward edge; the CI check does.
- **The roster is bound once** (above the vestigial `_:`), so every route returns the same value.
  When it was bound per application, an `import`-ed member re-allocated and `==` came back false.
- **The roster is fully lazy:** `attrNames` works even when every member is a `throw`. That is why
  the CI check needs `deepSeq` to actually force members.
- **Bucket identity is checked by value equality**, not shape: a library re-imported at another
  pin has identical names and types but is a different build.
- Retiring a member: drop the binding, the stratum line and the hub pin together; archive the repo,
  never delete it; record the destination of every export.

## Working in it

- The real gate is `nix flake check ./ci`. The hub has no `ci` devshell command.
- `nix flake check .` at the ROOT is a false green: it prints `all checks passed!` after checking
  only output shape.
- `nix eval .` at the root fails: there are no packages/devShells. Use the Drift check:
  `nix eval --impure --json --expr 'let f = builtins.getFlake (toString ./.); in { lib = builtins.attrNames f.lib; roster = builtins.attrNames (f.lib.mkGenLibs { }); }'`.
- CI jobs: `evaluators` (the shared gen-harness workflow over `.` and `./ci`), `perf-bench`
  (`nix run ./ci#perf-bench`; parity-gated, so fast-but-wrong fails), `sole-evaluator-report`,
  `fleet-consistency` (re-derives every cited fleet number from baselines). Format: `nix fmt -- --ci` in `ci/`.
- The ci subflake reads the hub via `builtins.getFlake` of `self.sourceInfo` with its narHash:
  source is the working tree, member pins come from the ROOT `flake.lock`. A root pin bump is seen
  by CI with no ci relock. Do not make it a `path:..` input: Lix refuses that lock node, and a
  Lix-written `path:` lock pins a stale snapshot.
- The hub is a TRAILING node in a relock: bump it after all members, then gen-demo after it.

## Traps

- **Hand-maintained tripwires.** `expectedKeys` and `expectedSurface` in `ci/mkgenlibs-eval.nix`
  must be bumped in the SAME commit as the roster or pin change. A missing entry drifts by
  construction; regenerate surface hashes only via `./ci#lib.mkGenLibsEval.surfaceHashes`.
- **`expectedSurface` is blind to behaviour changes** under an unchanged export surface: a docs-only
  bump leaves the surface hash identical.
- **`--override-input` on a removed input warns and returns a clean green.** A control built on
  overriding an input dies silently when that input leaves; keep controls as in-file synthetic
  fixtures that run as gate cells.
- **`tryEval` cannot catch a missing attribute/input** (`{ }.nope` aborts the whole eval). Only
  `throw` is catchable; a per-key `tryEval` wrapper will not name which key broke.
- **AGENTS.md is CI-bound.** The roster, inputs, strata and drift blocks between
  `<!-- gen-*:begin/end -->` markers are re-derived and compared; a `gen-*` name outside them must be
  a live input or a registered row; a BACKTICKED retired key is refused (write `gen-pipe`, not the bare key).
- `mkCore` (gen-class) rejects a hand-built `{ members; archetype; }`; the class must come from `mkClass`.

Related: \[[gen-overview]\] \[[gen-class]\] \[[gen-flake]\]
