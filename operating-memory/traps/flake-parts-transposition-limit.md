---
name: flake-parts-transposition-limit
description: When using flake-parts' system-scoped inputs'/self' (or wrappers that inject them as module args)
type: trap
verified: unverified
---

**Rule:** `inputs'` and `self'` expose only attributes declared in flake-parts' `transposition` config. Custom outputs set via `flake.<name> =` are not reachable through them.

**Why:** A config with no `transposition` declarations gets only the built-ins: `packages`, `legacyPackages`, `devShells`, `checks`, `apps`, `formatter`. Kubernetes chart references living in a custom output had to keep the indexed form `inputs.<flake>.<output>.${system}`. Converting them would have meant declaring transpositions and extending the injecting wrapper to another class.

Related measured facts:

- Wiring that injects a lazy module arg "builds fine" before any consumer exists, because nothing forces it until a class body reads it. Unforced wiring proves nothing.
- Earlier infinite recursions in this area had two causes. One was probing for a flake-parts option to detect flake-parts context (the option exists only inside a mkFlake context, so the probe recursed). The fix was to guard on a cheap special arg. The other was force-walking values during output assembly, which re-entered the `self` fixpoint.

**How to apply:**

- Convert `inputs.<f>.packages.${system}.x` to `inputs'.<f>.packages.x` only for transposed attributes, and verify byte-identity of the result.
- Drop the plain `inputs` arg only if it is genuinely unused. Imports and non-system-scoped module sets still need it.
- Detect a context by a cheap special arg, never by probing for an option that may not exist yet.

Related: \[[nix-laziness-design]\]
