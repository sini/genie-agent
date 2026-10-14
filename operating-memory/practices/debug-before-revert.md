---
name: debug-before-revert
description: When a change appears to cause regressions and reverting it is tempting
type: practice
---

**Rule:** Diagnose the specific failure before reverting. The fix is usually smaller than the
revert, and the most common "regression" is pre-existing code that the change made reachable
for the first time.

**Why:**

- A complete feature (deferred includes) was nearly reverted because a `deepSeq` over
  interpreter state forced lazy children. The fix was wrapping the field as a thunk chain, the
  same pattern already used for a sibling field: one line, against reverting 70+ working lines.
- Five instances in one project, all the same shape: a fix woke a dormant path, and it
  presented as breakage. A branch collected for the first time throws its content ("present
  and throwing", not "absent"). Parentage firing for the first time trips an invariant that
  had held by accident. A policy at a new scope fires at a node that did not exist before. A
  complete config wins where an empty one used to, so a downstream consumer finally runs and
  fails. Each time the answer was repair, not revert.

**How to apply:**

1. Read the actual error message.
2. Evaluate both sides and compare WHICH error fired, never just red against red. Two
   different errors are two facts.
3. Name the state change that made the path reachable. If you cannot, the classification is a
   guess.
4. "This could not have run before" needs a positive control. For example, a throwing
   sentinel showed `builtins.sort cmp [ bomb ]` never invokes the comparator.
5. Try the targeted fix. Revert only if it fails AND you understand why.
6. If an agent's work looks mostly correct, fix the gap; do not redo the work.
7. Do not gate acceptance on an error string ("X missing must not appear"). Gate on the
   property, for example by enumerating what survived to show nothing was deleted.

Related: \[[by-construction-over-repair]\] \[[armed-controls]\]
