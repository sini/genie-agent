---
name: tested-path-equals-shipped-path
description: When a project's CI exercises a different resolution path, evaluator or input wiring than its users
type: practice
---

**Rule:** Find out which path your users actually take, and make CI exercise that path, under every evaluator you claim to support.

**Why / measured:**

- A framework that declares no flake inputs resolves its library hub through a `fetchTarball` fallback that reads a rev from a template's lockfile. Its own CI used the flake-input path. The two paths carried different transitive library revisions from one pin, so a consumer hit a throw that a 1221-cell suite could not see.
- A narrow sub-flake without the input did exercise the fallback. Eight cells there caught an old-pin/new-wiring mismatch that the flake arm read as 4/4 green. A bump validated only by `--override-input hub/member` can never turn that arm green, because the fallback reads the lock node directly.
- Local development ran one Nix evaluator while CI ran another with lazy trees on. A flake input's path text is a per-evaluation virtual path under lazy trees, so a minting defect was green locally and red in CI. The owner then required every library to work under all three major evaluators (upstream Nix, Determinate and Lix), with exact pins kept at the latest release and a staleness reader that turns a pin red when it falls behind.

**How to apply:**

- For a fallback-resolving project, also verify bumps on a consumer template that declares no input (`nix flake check --override-input <framework> .`).
- Every acceptance oracle names all evaluators. A result that differs between evaluators is a defect unless the divergence is stated.
- Note per-evaluator quirks. For example, one evaluator's `flake check` does not force devShells, so evaluate them explicitly.

Related: \[[confirm-baseline-before-claiming-a-gap]\] \[[nix-which-flake-which-output]\]
