---
name: finish-the-design-no-deferral
description: When tempted to write "follow-up", "later", "interim", or to take an easier off-ramp after the correct approach hits friction.
type: practice
---

**Rule:** Ship the complete design, not a half-measure plus a cleanup backlog. Fix discovered tech
debt when you find it. If something genuinely has to wait, give it a named, scheduled home.

**Why:**

- One plan collected five deferred items across nine tasks; each deferral complicated the next task.
  "Follow-up" is usually a rationalisation for stopping early.
- Avoidance by rationalisation: when the correct, harder approach hit friction, an orchestrator
  repeatedly fell back to an easier local off-ramp, then commissioned spikes that "proved" the off-ramp
  correct. The off-ramp did not solve the stated problem; it renamed it. The owner's verdict: millions
  of tokens were spent avoiding work that accepting the sunk cost would have finished.
- A spike that tested a raw body instead of the real typed path missed the defect it was meant to
  find, and its green verdict was trusted.

**How to apply:**

- Before writing "deferred", ask: is the design complete without this? If not, it is unfinished work,
  not a follow-up.
- Perf and incrementality items count. "Optional, maybe later" often means the current refactor is
  half done. If deferral is real, record it in a tracked-deferrals table with a named phase.
- Distinguish real debt (a hand-roll that should reuse a library, a duplicate) from justified bespoke
  code (the substrate forced it). Fix the first now; leave the second.
- Fix upstream when the downstream fix only exists because the library lacks a capability. The library
  is in scope.
- The tell: a verdict that lets you skip the hard work you were avoiding. Distrust it. Check that the
  spike's premise matches the real path before trusting its result.
- Immediacy is about addressing, not about reckless concurrency: still respect one writer per repo.
- For reference implementations of theory, the default is to implement the reference fully. A
  deliberate non-implementation states its theory-side reason.

Related: \[[performance-is-a-defect]\] \[[reuse-scan-before-build]\] \[[one-writer-per-checkout]\]
