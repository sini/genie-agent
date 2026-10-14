---
name: do-not-wind-down-early
description: Context-budget gates for an orchestrator session, and the false stop conditions that look like completion; applies whenever you feel like summarising and stopping.
type: workflow
---

**Rule:** Below 75% context, keep starting new work. An idle fleet is a trigger to DISPATCH, not a
finish. Never estimate your context usage; act only on a real reading.

**Why:** Measured: a session closed six rows, published them, summarised and stopped at 54% context.
The owner had to prod it back to work, which spent the owner's attention (the scarcest resource) on a
prod instead of a decision. In another session, four self-estimates read ~76/~81/~85/~88% against
real readings of 48% and 59%; every estimate was HIGH, and each was acted on by declining to dispatch.
An early stop throws away the session's remaining capacity and cannot be recovered. A late stop is
recoverable by construction (compaction, then re-boot from the resume prompt and handoff).

**How to apply:**

| context reading     | gate                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| < 75%               | START NEW WORK FREELY: new subjects, sweeps, lanes                                                                                     |
| >= 75%              | NO FRESH SUBJECTS. Finish every open stream: fix rounds, gate contacts, landings, banking, filing already-measured findings            |
| >= 90%              | CLOSE OUT: bank obligations into tracker bodies, write the handoff (`handoff-and-close.md`)                                            |
| weekly quota >= 95% | clean, unhurried closeout: finish in-flight, dispatch nothing new. Evaluated last; outranks context gates; restricts NEW dispatch only |

- 75% blocks fresh SUBJECTS, not delivery. Test: does this CONTINUE something underway, or START
  something?
- "In flight" means a stream of work, not a running agent.
- The only admissible context values are the last real reading and a fresh one. Unknown? Say
  "unknown, last reading N%". Where truly unknown, KEEP WORKING.
- `ctx ?%` is a broken instrument, never zero.
- If compaction happens anyway: re-boot from the resume prompt, then the handoff. Do not continue
  from the compaction summary.

**The false stop conditions** (each reads like completion; none is):

- "The fleet is drained" -> a dispatch trigger.
- "Everything is committed and published" -> a clean STATE, not an empty QUEUE.
- "The rest is the owner's" -> run the frontier query; warranted unblocked work is almost always there.
- "This is a natural place to summarise" -> a summary is not a deliverable unless someone asked.

**And an early handoff is wasted work:** the handoff file is wholesale-replaced at close, so one
drafted at 54% is rewritten at 90%. Bank obligations into tracker item bodies as you go instead.

Related: \[[orchestrator-operating-rules]\] \[[handoff-and-close]\] \[[resume-prompt-template]\]
