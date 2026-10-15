---
name: nix-lsp-traps
description: When choosing or calling a Nix language server from an agent
type: trap
verified: unverified
---

**Rule:** Prefer a Nix LSP that cannot hang the agent. Use it for intra-file structure only, and use grep for anything that crosses a file boundary.

**Why / measured (six identical probes on two servers):**

- One server held its request handler on an untimed semaphore acquire. A `hover` ran over 2 minutes and was killed, and `workspace/symbol` (which had no handler) hung forever and wedged the server, so every later request failed with "server is running". An agent cannot cancel, so this is fatal.
- The other server returned a real hierarchical outline from `documentSymbol` (instead of a 127 KB raw parse tree), answered hover instantly with an inferred signature, and failed `workspace/symbol` cleanly with "No such method".
- Neither server does cross-file analysis: goto across an `import` returns nothing on both. One documents this outright as unimplemented.
- Issuing several LSP calls in one batch caused confusing errors on the hanging server.

**How to apply:**

- Coordinates are 1-based for both line and character, and the cursor must be on the symbol (indent + 1 gives the column of a binding).
- Loop: `documentSymbol` first (pass 1,1) to find lines, then position-based calls. `documentSymbol` gives lines but not columns.
- `goToDefinition` at a usage, `findReferences` at the definition (usages only), `hover` at a definition for its shape.
- Any LSP call also surfaces that file's diagnostics, a free lint pass.
- Keep one LSP call per tool block until batching is proven safe on your server.

Related: \[[code-graph-index-traps]\]
