---
name: nix-laziness-design
description: When designing Nix code that crosses scopes, holds configs in state, or validates module arguments
type: practice
---

**Rule:** In Nix, the invariant is usually "no FORCE", not "no REFERENCE". Hold lazy references freely, force deliberately and shallowly, and prefer a loud infinite-recursion error to a silent wrong answer.

**Why / measured:**

- Cross-host config-thunk resolution looked like it needed a new stratum and an engine. A spike showed that `evalModules`' own lazy fixpoint co-evaluates: an acyclic use resolves, and a genuine cycle throws a loud, uncatchable recursion. "No silent cycle" strictly dominates the older stratum design, which was silently wrong on the circular case.
- A reviewer claimed that reading an aggregate an app also emits into is cyclic. It is not: emission and consumption are different attributes, and per-attribute laziness handles it. The invariant to enforce is narrower: emission must never read the aggregate.
- An effects runtime `deepSeq`ed its state, forcing every option default of any config object held there. Wrapping the value as `_: value` hides it (`deepSeq` skips lambdas). Store keys, not configs, where only presence matters. This applies to that runtime only; do not carry the fear to designs without the deep force.
- Threading `_: value` closures with `prev // {...}` per step made forcing the final map chain through every closure (5660 frames, stack overflow). Forcing only the top-level spine each step (`builtins.seq (attrNames m) m`) collapsed the depth to O(1) and kept bodies lazy.
- A collision validator forced `config._module.args` at collection time and recursed through the `evalModules` it was checking. Keep validators lazy. The consequence is that errors then surface only when `warnings` are forced.
- An `mkIf` gate can gate config but cannot conditionally declare an option: that would need `imports ← guard(options) ← options ← imports`.
- Key maps by identity hash, not by coordinates: function-valued declarations break JSON serialization.
- Emits forced during assembly must self-gate as a list (`optionals (pathExists f) [...]`), or a missing file throws fleet-wide.

Related: \[[nix-hidden-unsoundness]\] \[[nix-tryeval-and-equality]\] \[[flake-parts-transposition-limit]\]
