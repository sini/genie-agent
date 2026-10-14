---
name: integration-validates
description: When assessing progress or rating something a "win", and when deciding what a library landing must prove
type: practice
---

**Rule:** A capability is demonstrated by a consumer running it, or it is unproven. Green
suites prove mechanics; only a real consumer evaluating a real configuration proves the
design. Put the consumer's arm on every library landing.

**Why:** an assessment called a demo corpus "the biggest real win" because of green CI,
construct counts and commit mix. Those are artefact counts. Owner: "it's worth calling a spade
a spade; [it] was in many ways a lazy implementation. It wasn't conformant with the standards
and has undergone zero user review; it exists as a place for agents to implement their
(possibly) ceremony." When a schema library was bumped in a real downstream consumer, it
pulled in a merge library that exposed real issues and took several rounds to fix, a fix the
downstream agent believed would be simple. "For all of our careful documentation and review,
we're still shipping things that were finally validated by integration." Most lines were CI
on modules not yet shown to solve the problem, and no end-to-end fleet graph or policy had
ever been demonstrated.

**How to apply:**

- Before rating anything a win, ask: what did a user see run?
- A documentation or review round that cannot fail on integration is not a gate.
- Call it lazy when it was. A build that reaches its exit oracle by bypassing the framework's
  own patterns is something the owner will have to unwind, not a win with caveats.
- When boot-reading, check the owner's stated asks against the tracker, not only the tracker
  against itself.
- Velocity is the metric the owner watches. Early libraries were built in single sessions,
  and "several sessions per increment" is the defect. Process changes are welcome for speed,
  provided end-product quality holds.
- Exploratory asks mean INTERROGATING the materialised graph (for example, SQL-like queries
  over it), not just drawing a picture of it.

Related: \[[filing-caps]\] \[[backlog-is-one-defect]\]
