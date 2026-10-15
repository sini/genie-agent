---
name: code-graph-index-traps
description: When using a code knowledge-graph index (e.g. codebase-memory) for absence, caller or dead-code claims
type: trap
verified: unverified
---

**Rule:** Use a code graph for structure and shape questions. Derive every absence claim, including "zero callers" and "symbol not found", from grep with a live control.

**Why / measured on a large Nix codebase:**

- The architecture summary's `languages` field did not list Nix while 2195 Nix functions were indexed in the same response. An agent told to confirm coverage from that field concludes Nix is unindexed and throws away the whole capability.
- CALLS edges miss calls made through an imported attrset (`x = lib.y.runPrePass { ... }`), which is Nix's dominant cross-module idiom. `trace_path` reported zero callers while grep found the call, and a control showed caller-tracing worked for direct calls. Zero callers is not evidence of dead code.
- Symbol search returned only Function nodes, so non-function `let` bindings read as absent. That would have produced false "dissolved" verdicts in an audit.
- Complexity properties lived on `f.file_path`, not `f.file`. A wrong property name returns 0 rows silently.
- Loop and recursion metrics are near-useless for Nix: folds are `foldl'` calls, not syntactic loops. The working discriminator was a grep for "does the folded lambda read the accumulator?".
- Passing a fast/moderate index mode skipped directories by name (`gen`, `docs`, `scripts`, `tools`, `bin`, `build`, ...). A skipped directory looks exactly like absent code.
- Cross-repo matching found 0 edges between pure libraries. It matches HTTP routes and channels, not imports.
- An earlier "zero symbols for Nix" reading was correct when measured and wrong two weeks later, after the indexer and its pin were fixed.

**How to apply:**

- Confirm coverage with a known-positive symbol query.
- Use the body-token field for "what does this body do" (it can show a symbol was rerouted, not merely renamed).
- Never pass an index mode. Re-measure capability claims before relying on them.

Related: \[[nix-lsp-traps]\] \[[git-measurement-traps]\] \[[controls-for-absence-claims]\]
