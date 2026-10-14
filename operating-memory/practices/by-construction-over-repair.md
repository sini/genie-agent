---
name: by-construction-over-repair
description: When a defect could be fixed by a guard, filter, dedup or normalisation pass, or when workarounds are piling up on one component
type: practice
---

**Rule:** Prefer a construction where the defect cannot arise over one where it arises and is
then corrected. When three or more workarounds have been added for the same root cause, stop
patching and redesign the component.

**Why:**

- Owner: "dedup is valid, but it's better if there's no duplication by construction." A
  repair is an invariant someone must keep maintaining. It regresses silently on later edits,
  must be re-applied at every new call site, and leaves the cause in place. It often costs
  more too: deduplicating after path enumeration removes the duplicate results but still walks
  Θ(2^k) paths.
- One migration added five dedup mechanisms to work around a monolithic handler that
  replicated the old architecture. Five workarounds meant five sources of subtle interaction
  bugs. The fix was to use the system's own composition primitives instead of reimplementing
  state management.
- The tell of drift: a design's theory section argued "eliminate the shape rather than
  constrain it" while its mechanism section enumerated paths and proposed deduplicating them.

**How to apply:**

1. State the defect class.
2. Ask which construction makes it unrepresentable before reaching for a guard, filter, dedup
   or normalisation pass.
3. Search the libraries already in scope for that construction first. It is often a
   neighbouring primitive.
4. If no such construction exists, say so explicitly and justify the repair, rather than
   defaulting to it silently.
5. Count workarounds per component. At three, redesign.
   Schema form of the same rule: a required, total field instead of a default
   (\[[absence-is-a-decision]\]).

Related: \[[design-bar-theory-not-compat]\] \[[debug-before-revert]\]
