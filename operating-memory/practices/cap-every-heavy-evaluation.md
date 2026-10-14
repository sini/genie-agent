---
name: cap-every-heavy-evaluation
description: Before running any nix eval, build, flake check or test suite, and in every brief that tells an agent to
type: practice
---

**Rule:** Run every evaluation, build, check and test suite under a memory cap, and put the
cap line in every brief that runs Nix. An exit of 137 under the cap is a FINDING (a possible
memory regression), not an obstacle.

**Why:** an agent's test pushed a shared workstation out of memory, and the owner had to kill
it by hand. Telling agents to "run heavy work serially" was not enough: as the owner put it, an
agent cannot know a dispatch is heavy when the heaviness is an unintended regression. The same
day, a runaway evaluation capped at 64M died with rc 137 and harmed nothing else.

**How to apply:**

- Command shape:
  `systemd-run --user --scope -p MemoryMax=12G -p MemorySwapMax=0 --quiet <nix command>`
- On rc 137: report the command and the cap. Never re-run uncapped to "see if it passes".
- Still keep known-heavy work (benchmarks, full member suites, multi-evaluator runs) serial.
  A fleet cap limits the number of agents, not their memory.
- Read the exit status unpiped (`cmd > out 2> err; echo $?`). A pipe masks the 137.

Related: \[[writing-a-dispatch-brief]\] \[[ci-gate-discipline]\]
