---
name: reference-implementation-surface-is-intentional
description: When reviewing a module, battery or library presented as a reference implementation and its options or helpers have no consumer in this codebase
type: practice
---

**Rule:** In an artefact built as a reference implementation, an opt-in surface with no local consumer
is documentation and an extension point, not dead code. Review it for correctness and idiom; do not
apply YAGNI deletion to it.

**Why:** A review flagged a configuration battery's opt-in class, its enable switch and two path
helpers as dead code to drop. Owner: "this was requested as a reference implementation; the surface is
intended as documentation or for future extension." The comments were withdrawn. A reference shows
the full shape another fleet can opt into, so an option unused here is not unused.

**How to apply:** before calling an unused option dead, check whether the PR body or docs present the
artefact as a reference ("other fleets can …"). If so, review that surface for correctness;
duplication, idiom and drift risk are still fair findings.

Related: \[[reviewer-findings-are-hypotheses]\]
