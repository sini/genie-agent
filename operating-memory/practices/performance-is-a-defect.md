---
name: performance-is-a-defect
description: When a design or audit shows a complexity blowup, an avoidable exponential, or an O(n^2) where O(n) exists.
type: practice
---

**Rule:** Performance problems are defects. File and track them like wrong answers. Never dismiss one
as "an optimisation", "acceptable cost", or "only matters at scale we have not reached".

**Why:** Correctness and cost fail the same way: silently, at a scale nobody probed. An orchestrator
once described a Θ(2^k) blowup as "not a standalone bug" because a correctness repair happened to
remove it. That leaves the cause in place for the next caller to reintroduce. A design that is correct
and exponential is not fixed. A cost defect returning the right answer with nothing reporting the
degradation is a silent failure, and silent failures are the ones that matter most.

**How to apply:**

- State the complexity of the chosen instrument, not only its answer. If the substrate offers a
  cheaper one, using the dearer one needs a stated reason.
- Price against the target scale (here: thousands of hosts), not the small test corpus. "The corpus
  never hits it" is not a defence.
- A perf finding goes through the same pipeline as any defect: measured, controlled, reviewed, tracked.
- Before committing a representation change (a cached field turned into a function, or the reverse),
  state demand frequency and recompute-versus-cache cost, measured or marked unmeasured.
- Before telling the owner a cost floor is "irreducible", check whether that was measured or argued.
  If argued, run the spike. One such spike found two assumed levers were worse, one real lever nobody
  had tried, and a misread cost driver.

Related: \[[finish-the-design-no-deferral]\] \[[presenting-a-decision]\]
