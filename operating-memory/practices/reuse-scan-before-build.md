---
name: reuse-scan-before-build
description: Before designing or building any new engine, library, mechanism or helper in an ecosystem of existing libraries; and when adopting a library primitive to replace hand-rolled code.
type: practice
---

**Rule:** Step 0 of any build is a reuse scan: which existing library already provides this? Scan to
primitive granularity, treat an absence in any capability map as a hypothesis, and when adopting a
library check that its surface has YOUR semantics.

**Why:**

- A design proposed a new `gen-fixpoint` library that was about 85% of the already-shipped
  `gen-resolve`. Only a lateral
  question from the owner caught it. Adversarial review verifies CLAIMS; it cannot flag an OMISSION,
  because the unconsidered library is not in the spec to check. Anchoring on "build X" propagates
  into every grounder and reviewer prompt.
- A design picked the right library and the wrong primitive: `gen-graph`'s `query` (paths mode
  threads its visited set per path, so it duplicates nodes on non-tree shapes), when
  `gen-graph/lib/preorder.nix`, one file over, visits each node once via `foldl'`. Two
  review rounds prescribed a post-hoc dedup repair instead.
- A capability map declared `gen-product`'s `latticeGraph` "genuinely absent" on the very day the
  commit adding it landed; `gen-link` was missing from the map entirely. The entry was false when written.
- Adopting `gen-graph` for a hand-rolled closure: `reachableFrom` excluded the start node; the
  library form had no recursion, so a cycle that used to abort was now answered silently; one primitive
  was partial with an uncatchable error; a transpose silently dropped edges from outside its declared
  node set. One-hop inputs all agreed, so the domain looked cleared.
- A lone scout refuting items from a large multi-agent audit ("needs a new primitive") was wrong on all
  four re-checked items: it compared against the one obvious primitive, not the full built set.

**How to apply:**

- Frame grounders as "what already exists for this?", never hand them your build premise. Give the
  reviewer a duplication lens: "what does this duplicate or fail to leverage?"
- If an existing library covers about 70% or more, extend it; do not build.
- When a finding names an instrument, treat it as a pointer: enumerate the library's full export
  surface and read the neighbouring modules' headers.
- An absence claim needs a dated grep over the library at a named rev with a positive control; else
  the answer is "unknown".
- Before binding a primitive, read its source at the rev your lock pins: reflexivity, totality,
  faithfulness against an oracle, error containment, behaviour on inputs the examples do not show,
  and what the old shape enforced for free. Run an equivalence probe over several shapes, including
  ones with something in the middle, with a deliberately wrong variant that must disagree.
- Layering: a thin adapter or compatibility layer must contain no recursion, fixpoint, fold over a
  graph, edge walk or transpose. If it does, it is in the wrong layer; route it through the library.
  A hand-rolled function matching a library API is duplication even if it works today; it drifts.
- A "needs a new primitive" verdict must name which built extension was intended, prove why it fails,
  and cross-check the full built set. Re-verify audit refutations with more than one agent.

Related: \[[write-the-target-expression-first]\] \[[finish-the-design-no-deferral]\]
