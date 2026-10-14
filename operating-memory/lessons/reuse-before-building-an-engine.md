---
name: reuse-before-building-an-engine
description: Before building a general engine, primitive or library feature, or before reporting a capability gap
type: practice
---

**Rule:** Before building anything engine-shaped, find the library that would own the concern and measure there. Report a gap only after you have named that owner and searched it.

**Why / measured:**

- A cross-cutting resource-derivation design went through three framings. Two successive reviewers each proposed a general engine (a dispatch fixpoint, then a scope-graph walk), and both over-reached. The final design was a plain recursive desugar plus existing fan-in machinery, with no engine at all. The primitives already in the repo covered it.
- A reviewer proposed adding a transitive-closure primitive to gen-scope, having read it in isolation. Closure and reachability already shipped in gen-graph (`reachableFrom`). The architecture split was that one library owns edge data and evaluation, and the other owns the query.
- An agent measured "0 merge functions" in gen-types (true, with a firing control) and concluded the ecosystem had no per-type merge semantics. That reached the owner and a published report. Merge lived in gen-merge (`lib/types.nix`), which reimplemented the list/attrs/submodule merges recursively. The real gap was one leaf default.
- A self-authored audit catalog was self-exculpating. An adversarial workflow (steelman the defense, confirm only the survivors) produced the authoritative roadmap, which concluded: build the missing general primitives in the shared libraries first, then remove the consumer's hand-rolled versions.

**How to apply:**

- Keep a one-line-per-library capability map. Absence claims in it expire silently, so re-derive the roster from the authoritative file, not from a written count.
- A zero in the library you happen to be reading is evidence about that library only.
- Wrong library and wrong word are the same failure: the measurement is sound and the domain is wrong.

Related: \[[read-the-system-not-the-story]\] \[[controls-for-absence-claims]\]
