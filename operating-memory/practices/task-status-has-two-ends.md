---
name: task-status-has-two-ends
description: When dispatching an agent against a tracked task, and when an agent returns.
type: practice
---

**Rule:** The orchestrator claims a task (`in_progress`) in the same act as spawning its agent, and
releases it to `open` when the agent returns. Only the reviewer closes it. An implementer does neither.

**Why:**

- Four agents ran against four tasks, all still `open`. Owner: "none of the current tasks are flagged
  in progress when I use the viewer." The orchestrator experiences the dispatch as the state change and
  forgets nothing outside its own context observed it. The graph is what survives compaction, so a
  lying graph defeats its purpose.
- The opposite drift: "4 active agents and 19 in-progress tasks". Fourteen were claimed with no live
  agent, because their next stage (review, landing) was queued.
- Completion is an accept decision. An implementer that self-completes skips the review gate.

**How to apply:**

1. Spawn and claim are one operation: `br update <id> --status in_progress` before the agent starts.
2. `in_progress` means a live agent holds the row, nothing else. When the agent returns, release to
   `open` with state banked in the body, even if the next stage is queued; re-claim at next dispatch.
3. Implementer: verify, then report (status, what was built, verification tails, commit, concerns).
4. Reviewer/controller closes, with a reason. A rejection with no recorded reason gets re-proposed.
5. Bank state in the task's body, not in comments or chat; the body is what a successor reads.

Related: \[[concurrency-budget]\] \[[agent-liveness-and-ownership]\]
