---
name: spec-and-plan-before-code
description: Before any code change, and when moving from a written plan into multi-task execution.
type: workflow
---

**Rule:** Spec first and file the tracking task before touching code, including one-line changes.
After writing a plan, dispatch an INDEPENDENT plan reviewer before the first task. Execute with a
fresh agent per task and a two-stage review.

**Why:**

- A one-line change to public `gen-schema` (`_kind` on every instance) was measured green, committed and pushed with no spec. The
  owner rejected it on five design grounds (denormalisation, surface growth, non-totality on empty
  input, direction of contamination, re-nominalising a structural surface). It cost a public revert, a
  lock bump and three thrown-away fixture edits. Measurement answers "does it work"; the objections
  were "should it exist in this shape". The smallness made it feel exempt.
- The plan review was skipped twice. Cause: a seam between two skills. The plan-writing skill ends in
  SELF-review and a hard handoff; the execution skill reviews per task, never the whole plan.
- A correction that replicated: the content was fixed by measurement, but its EXTENT was not. A first
  grep found 3 sites, a second spelling found 3 more, a third spelling and an inherited direct call
  surfaced only at review. A change's blast radius is not derivable from its content.
- A plan with exact before/after code, executed by a fresh agent per task with two-stage review,
  shipped a 7-task, 25-file refactor with zero rework.

**How to apply:**

- Spec records rejected routes with reasons so later sessions cannot re-litigate them. Review the
  SPEC, then implement.
- When a correction replicates, the artefact to write and review is the SWEEP PREDICATE, with a
  liveness control on a known positive in a DIFFERENT spelling.
- Review chain: design review, spec review, PLAN review, per-task spec-compliance then quality review.
- Explore exhaustively before planning (exact paths, signatures, caller inventory). Plans carry
  concrete diffs and file references, not prose.
- Fresh worker per task with full context in the prompt. The coordinator applies 2-line review fixes
  itself rather than re-dispatching.
- Map the dependency chain so independent tasks run without blocking.
- Honour a requested checkpoint before a big mechanical grind even if the end state would be green;
  its value is catching a wrong turn before the cost is paid.
- When a worker reports "gaps I worked around", check whether the gap belongs at the source library.
  Re-run the gate yourself rather than accepting a worker's green.

Related: \[[reviewable-artefact]\] \[[review-economy]\] \[[writing-a-dispatch-brief]\]
