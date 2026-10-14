---
name: design-bar-theory-not-compat
description: When choosing between a principled design and one that preserves an old implementation's behaviour, API or assembly order
type: practice
---

**Rule:** Every design must be defensible as an expression of its theory. "The old system did
it this way", "this is the smaller change" and "the oracle differs" are not justifications.
The priority order: (1) native expression and simplicity, (2) byte identity with the old
output, but only if it comes for free.

**Why:**

- Owner: "I don't want to throw effort at fixing compatibility of an incorrectly designed
  system. Effort/cost ignored, reject YAGNI. Sunk cost is not a justification, no shortcuts.
  Tech debt is P1." A rewrite carrying the old runtime's patterns (state-accumulator
  threading, hand-rolled schedules, magic marker keys) is a prototype in a costume, however
  green its corpus evaluation.
- **Equivalence, not identity.** A design chose a path-enumeration mode *because* it
  reproduced the old fold's concatenation order, and declared sorting a non-goal because it
  "would redden parity". Two configurations are equivalent when they resolve to the same
  thing, and Nix option merging is order-insensitive. Identity bought with complexity is a
  defect.
- **The old system is not a golden reference.** It had known bugs, so capturing its output as
  a golden corpus makes the bugs the specification and makes the fixes read as regressions.
- **A library extension that reproduces a legacy limit is a band-aid.** An `onMiss` hook added
  to gen-aspects to mimic the old system's ceiling was pushed before the owner questioned the
  requirement, and it had to be reverted forward-only.

**How to apply:**

- Litmus for a legacy holdover: does it thread state, dispatch on a tag into an accumulator,
  hand-roll a fixpoint or reachability, or smuggle a `__`-marker? Then dissolve it; do not
  patch it.
- State parity claims as EQUIVALENCE unless identity is genuinely required, and say which you
  mean. A `drvPath`-identical gate is sufficient, never necessary.
- Oracles and sample configurations are tools that catch mistakes. They do not define the
  design.
- A shared-library change whose requirement the owner has not confirmed, especially one
  justified as preserving legacy behaviour, gets sign-off on the REQUIREMENT before anyone
  builds it, and the brief says "stop and report before pushing".
- Improve leaky APIs rather than preserving them (for example, a sentinel key smuggled through
  bindings). Expose the raw calculus AND the compositions on it, and say which is which, so
  consumers never have to re-implement a hidden primitive (gen-pipe's `matchView` was unexported
  while its `select` composition was exported; `setAttrByPath` had three private twins). Mark which parameters are the
  cited theory and which are your own extension.
- Input pins are not design constraints: bump them.

Related: \[[by-construction-over-repair]\] \[[generic-core-no-consumer-names]\] \[[graph-native-modelling]\]
