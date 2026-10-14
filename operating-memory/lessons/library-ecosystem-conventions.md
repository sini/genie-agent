---
name: library-ecosystem-conventions
description: When maintaining a family of small, independently published Nix libraries with a hub
type: practice
---

**Rule:** Keep a single authoritative roster file, one tracker for the whole ecosystem, and conventions enforced by tests rather than by memory.

**Why / measured conventions that held up:**

- **Roster:** the hub's wiring file (`gen/lib/mkGenLibs.nix` in the gen ecosystem) is the authoritative list of libraries. Every hardcoded count in a doc or memory went stale, once in three places at the same time.
- **Clones mirror remotes:** clone `github:<owner>/<repo>` to `~/repos/<owner>/<repo>`. Notes written before a reparent cite paths that no longer exist, and an existence check against them reports a real repo as missing.
- **One output:** each library flake exposes a single `.lib` value. `lib/default.nix` is a pure function of named dependency values (no `inputs` bag, no in-library fetch). A file is a function if and only if it has dependencies; otherwise import it bare.
- **Loop separate from step:** the convergence loop went to gen-resolve, phase ordering to gen-graph (`phaseOrder`), and the single dispatch step to gen-dispatch. The step takes a pre-ordered phase list and does no internal sort.
- **Purity invariants are tests**, proven to have teeth by deliberate injection.
- **No local paths** (spec paths, worktrees, personal directories) in public docs or source comments, enforced as a hard failure.
- **Value injection, not type driving:** library types never enter a consumer's options tree (gen-flake is the single nixpkgs boundary). Only resolved values cross the boundary.
- **Metrics live on the hub**, not inside each library.
- **One tracker** for every library, with the library named in a title prefix, so a cross-repo dependency graph is not fragmented.
- **Deleting an API** leaves callers with a plain missing-attribute error and no guidance (gen-select's `sel.entityKind`). A scheduled deletion that happened was still documented as a "throwing stub with migration message". Update the docs the moment the stub goes.
- **Formatting:** the formatter may live only in a `ci/` sub-flake. A sweep that ran `nix fmt` from the root was a silent no-op and committed unformatted lines. Fresh checkouts lack generated pre-commit config, so hooks do not run there.

Related: \[[reuse-before-building-an-engine]\] \[[lockfile-minimal-delta]\]
