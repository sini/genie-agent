---
name: fix-flakes-dont-rerun
description: When a CI check goes red on a change that did not touch it, and you are tempted to re-run it and call it a flake
type: practice
---

**Rule:** A flaky check gets fixed, not re-run past. Find the race, replace racy reads with awaited
deterministic signals, and prove the fix with a mutant. A re-run only confirms the diagnosis.

**Why:** A VM check went red on a push that had not touched it. The agent re-ran the job and called it
a flake. Owner: "we should fix flakes, not just move past them." A re-run hides the defect until it
recurs, and a check that flakes is a check nobody trusts. This one was racy in two places: it read a
journal line once, before the service had logged it, and a sleep-then-count assertion depended on
machine speed. It also counted log lines rather than attempts, so its bound had been measuring the
wrong thing all along.

**How to apply:**

- On a red you believe unrelated, find the race in the same session and name it in the report.
- Prefer state the system records deterministically (`systemctl show -p ExecMainStatus`) over log
  text. Await log text (`wait_until_succeeds` in a NixOS test); never read it once.
- Replace sleep-then-count with "await N events, then assert on their own timestamps".
- Prove the fix with a mutant that the old check would have missed or passed.

Related: \[[ci-gate-discipline]\] \[[debug-before-revert]\] \[[control-must-differ-on-the-failing-axis]\]
