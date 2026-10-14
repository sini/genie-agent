---
name: one-engine-two-frontends
description: When building developer tooling (LSP + MCP, CLI + API) over an expensive evaluator
type: practice
---

**Rule:** Build one shared query engine with thin frontends. Ship the latency-tolerant frontend (MCP for agents) first, and make the evaluation backend pluggable.

**Why:** An LSP is held to ~200 ms interactive latency. An agent tolerates 5–30 s. Building the MCP frontend first let the valuable feature, resolved evaluated state, ship on the short path, with LSP interactivity as later polish (the rust-analyzer pattern). The owner reframed the tool as a service for users on any Nix interpreter. That made interpreter-agnosticism a requirement and the evaluation boundary a pluggable backend: by default, drive the user's own `nix` subprocess (always build-accurate), and optionally run a warm per-interpreter worker. Agnosticism at the protocol boundary also kept the controller free of FFI against an unstable C API.

Measured findings that shaped it:

- Resolution was scopable per node: resolving one node did not force the fleet, and time stayed flat in fleet size. The eager hazard was confined to one validation table. Engine rule: resolve via the per-id accessor and never force the whole outputs table.
- `toJSON` special-cases derivations, so the crash guard for enumeration is a depth bound, not a type tag. `tryEval` cannot catch a stack overflow.
- The owner's corrections: put it in its own repo, not inside the framework, and have the framework auto-export it.
- Record every probe discovery in both the spec and the roadmap, not only in memory or chat.
- Strip host names and figures from any public mirror of the spec.

Related: \[[codemod-verification]\] \[[nix-lsp-traps]\]
