---
name: gen-class
description: Working in or calling gen-class — partition nodes into classes, compute a byte-identical shared core, apply it back, and gate every reuse claim by digest.
type: reference
---

**Purpose:** the class-share mechanism. Group nodes into classes by a caller-supplied key
(`mkClasses`), compute each class's byte-identical shared **core** over a named projection
(`mkCore`), apply that core back onto a member (`applyCoreMerge` / `applyCoreExtend` / tier-2
`applyCoreFixed`), and authorise every reuse claim by sha256 over canonical `toJSON` (`gateCore`).
Use case: many hosts share most of a config subtree; evaluate the shared part once, safely.

**Depends on / used by:** gen-prelude is the sole flake input; gen-merge is INJECTED as a value
(never a flake input) for tier 2. Aspects stratum. NOT its job: deciding which nodes form a class
(the caller supplies `keyOf`; boundaries are declared, never discovered), cross-evaluation reuse
(gen-memo; gen-class is intra-process only), identity minting (gen-identity), building systems
(the terminal plane).

## Layout

- `lib/partition.nix` — `mkClasses`. `lib/contract.nix` — `mkClass`, `mkCoreRecord`, record shapes,
  digest. `lib/apply.nix` — `mkCore` (the oracle), the apply functions, `invariantUnder`.
  `lib/gate.nix` — `gateCore`, `compareCounters`. `lib/default.nix` — flat union of the four groups.
- `default.nix` — function of `{ prelude, merge }`; `merge` is an ordinary formal, so a caller
  supplying nothing gets the tier-2 surface. Pass `merge = null` explicitly for tier 1.

## API (ten names, flat)

- `mkClasses keyOf nodes` → `[Class]`, key-sorted, members sorted; `keyOf : name -> node -> string`.
- `mkClass { archetype ? null } key members` → `Class`.
- `mkCoreRecord { class; projection; sharedKeys; values; }` → `Core` from keys you already trust (strict).
- `mkCore { class; projection; projections; }` → `Core`: presence-guarded byte-identical
  intersection over the archetype's keys.
- `applyCoreMerge core memberProjection` → attrs (projection subtree; the core wins at shared keys).
- `applyCoreExtend core extend` — calls the caller's `extend { modules }`, force-wrapping each core
  key under the dotted projection path; pays the full per-member re-eval. Needs no nixpkgs itself.
- `applyCoreFixed { engineArgs } core modules` → `{ config; options; type; }` (tier 2, skips the
  merge spine; requires `merge`).
- `invariantUnder { class; projection; projections; }` → `{ invariant; divergingKeys; }`.
- `gateCore core { candidate; real; }` → `{ gate; candidateDigest; realDigest; coreCount; }`.
- `compareCounters mode { expected; actual; }` — `"exact"` for same-build, `{ band = 0.001; }` cross-build.
- Records: `Class = { _type = "gen-class/class"; key; members; archetype; }`; `Core = { _type = "gen-class/core"; class; projection; sharedKeys; values; digest; }`, `digest = sha256 (toJSON values)`.

## Invariants

- **Every reuse claim is gated.** A class-share is authorised only by byte equality between the
  core-applied candidate and the real member. There is no gate-free path; hard-fail on `gate == false`.
- **Defunctionalize before keying:** class behaviour is reduced to plain-data `Class` / `Core`
  records first, so partition / apply / gate work on first-order values.
- The digest is key-order-insensitive, and `core.digest` is the same function `gateCore` applies.
- The public surface never uses the verb `inject` (a fence test with a poisoned fixture checks it).
- The residual the gate cannot remove is the WHNF config-resolution spine.

## Working in it

- `nix develop ./ci --command ci` and `nix develop ./ci --command ci --tests-error` (refusal cells
  live in `ci/tests-error.nix`). `nix flake check ./ci` is CI's unguarded form.
- Purity scan over `lib/**.nix`, `flake.nix`, `default.nix`.
- Drift check compares the names under both tiers (`merge = null` vs injected); they must match.

## Traps

- `applyCoreFixed` is PRESENT on the merge-null surface and throws on CALL. Presence is not availability.
- `mkCore` scans only the ARCHETYPE's keys: a key all other members share is invisible. A key the
  archetype has and a member lacks is dropped silently (not a throw, not a share).
- The default archetype is the byte-order-first member, not `head members`; byte order means an
  uppercase name sorts first.
- `mkClasses` returns a LIST; empty input returns `[]`.
- Caller mistakes are refused catchably by name: `keyOf` returning a non-string; `projections` not
  covering every member; a function anywhere in a compared projection value (not serialisable).
- An empty intersection is a valid Core, and `applyCoreMerge` over it is the identity.
- `gateCore` returns `gate = false` as a record (never throws on outcome) but throws on a non-Core argument.
- `compareCounters` THROWS on a counter-set mismatch or bad mode rather than reporting `pass = false`.
  The band is inclusive; a zero baseline never passes a sub-unit band. Verdicts come back sorted by name.
- `invariantUnder` requires `projection` and then ignores it.
- `projection` is inert in `mkCore` / `applyCoreMerge` but a dotted PATH in `applyCoreExtend` /
  `applyCoreFixed`. `""` is accepted and builds a `""`-named option.
- `applyCoreFixed` returns the whole engine result; reach `.config`.
- `mkCore` rejects a hand-built `{ members; archetype; }`; build the class with `mkClass`.

Related: \[[gen-overview]\] \[[gen-aspects]\] \[[gen]\]
