---
name: concurrency-budget
description: Before dispatching a subagent — how many may run at once, which model tier, and what to do when over the cap.
type: practice
scope: local
values:
  budget-strong-equivalents: owner-set 2026-10-14
  strong-to-mid-ratio: provisional
  agents-while-owner-present: provisional
---

**Rule:** Concurrency is a quota budget counted in strong-model equivalents (one strong-tier agent =
two mid-tier agents). Count what is live with `ListAgents` before every dispatch, and pass `model`
explicitly on every call. If you find yourself over the cap, stop dispatching and let it drain; do not
kill working agents.

**Why:**

- Agent definitions that set no model inherit the parent's (strongest) tier. Seven unqualified
  dispatches ran against a cap of four because the cap was never read. Every unqualified dispatch
  spends a strong slot.
- The orchestrator then stopped three lanes to get under the cap. The owner reversed it: "resume
  those agents ... they've already spent the tokens." The cap governs NEW spend; killing a running
  agent throws away paid work and buys nothing back.
- An old, too-low recorded cap caused the opposite failure: one lane running while four were allowed.
- A spike of 18 orphaned nix shells looked like a reason to lower the cap. The owner rejected that:
  the cause was agents dispatched against stalled or blocked tasks, spawning retries.

**How to apply:**

- Example budget of 6 equivalents: 6 strong, or 5 strong + 2 mid, or 4 strong + 4 mid.
- Model roles: the strongest model orchestrates (main session only: dispatch, verdicts, records). A
  strong model is the default worker for anything with judgement (implementation, review, audits,
  spec authoring). A cheap model only for purely mechanical sweeps (grep, listing, classification).
- A resume by message is a dispatch for cap purposes, on the agent's original tier. Prefer resuming a
  mid-tier lane for bounded one-line remedies when the strong tier is full.
- Before dispatching, confirm the task is actually unblocked and that no stalled peer still holds it.
- Name every agent `<task>-<role>` so the owner can track the fleet and you can address it.
- While the owner is present in a live decision session, keep it to 2-3 concurrent agents
  (\[[presenting-a-decision]\]).
- The agent cap is not the only bound: heavy units are also sized to the host's heavy-run lock
  (\[[size-heavy-work-to-the-lock]\]).

Related: \[[resume-failed-agents]\] \[[one-writer-per-checkout]\] \[[presenting-a-decision]\] \[[size-heavy-work-to-the-lock]\]
