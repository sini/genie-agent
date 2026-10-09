---
name: gen-docs
description: Where the gen ecosystem's documentation lives, and which file is the authority on a library's scope.
metadata:
  type: reference
---

The gen hub, `github:sini/gen`, holds the ecosystem-wide documentation: `README.md` (the roster
of libraries and what each owns), `ARCHITECTURE.md`, `TERMINOLOGY.md`, `TRUST.md`,
`VALIDATION.md` and `BENCHMARKS.md`. Each library lives in its own repository,
`github:sini/gen-<name>`, and its `flake.nix` `description` and its `AGENTS.md` capability sheet
are the authority on its scope, including what it does not own and which sibling does.

Source: `github:sini/gen`, `README.md` ("What it provides", "Documentation").
