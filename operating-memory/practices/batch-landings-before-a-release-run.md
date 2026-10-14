---
name: batch-landings-before-a-release-run
description: Before dispatching a multi-repo pin-propagation ("relock") or release run.
type: practice
---

**Rule:** Dispatch a release run only once every landing meant for it has passed its gate. Never send
"also include X" to a run already executing; a late landing rides the next run.

**Why:** A pin-propagation run received two "include" messages after it had already merged the repos
they concerned. Both landings slipped a whole run, and one include risked publishing a red result if
merged without its partner. Agents read their inbox only after finishing the current tool round, so a
mid-run message reliably arrives late.

**How to apply:**

- When a gate is about to return for a landing, wait for it, then dispatch the run with the complete
  set.
- A run that stops on a red publishes nothing downstream of the red. Push its parked trailing repos
  (the `gen` hub, then the `gen-demo` corpus) as BRANCHES so the resume starts from gated work.
- Folding into a run is fine only before it has reached the repo in question.
- Units land on their own main at their own landing gate; the release run only bumps pins and reads CI.
- Exit a propagation run on a census by evaluation (does the new check appear in each consumer's
  evaluated check set?), never on "all CI runs green".
- A relaxation of the run's process is a trial with an acceptance number until measured.

Related: \[[review-economy]\] \[[ci-gate-discipline]\]
