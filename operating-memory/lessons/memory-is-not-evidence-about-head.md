---
name: memory-is-not-evidence-about-head
description: When a memory file, handoff note or dated block names a file, line, status or count that will drive work
type: practice
---

**Rule:** A memory is a point-in-time observation, never evidence about HEAD. Re-run the command behind any claim that will drive work before acting on it, and write memories as pointers plus durable rulings, not as state.

**Why / measured:**

- A memory said a refactor was "parked, the collision is still live". It was used to file a tracker row and a retirement register, both asserting predicates that had already been retired. Once questioned, the check took four commands.
- A project memory recorded a landed arc as "backburnered, zero shipped code" and added "do not resume without re-measuring", a line that would have stopped a session touching work already on main. The same file asserted that the real repository path "does not exist", as a correction.
- A dated block's motivating figures came from an earlier unlanded attempt, and nothing at HEAD reproduced them. An obligation recorded as "still owed" had already been built and wired into CI. All of these were caught by re-running, none by re-reading.
- An owner note "repository X is frozen" was read as "the whole track is frozen", and a task was nearly closed on that inference.

**How to apply:**

- Keep state in the tracker and git. Memory keeps only rulings and lessons that cannot be derived from them.
- Every claim about the tree carries the command that produced it, so the next reader re-derives instead of inheriting.
- When a dated block and a live reading disagree, the block is not wrong, it is old.
- A summary (a tracker title, an index line) must never outrank the primary it summarizes.

Related: \[[per-machine-state]\] \[[memory-bank-derived-observations]\]
