---
name: assert-which-refusal-fired
description: Applies when writing tests whose observable is an error, throw, or refusal.
type: trap
---

**Rule:** Where a refusal is the observable, design the cell so the expected refusal DIFFERS between
the buggy and the fixed build. Never rely on "it throws" alone.

**Why:** Fixtures differing by one pair of edges produced byte-identical refusal messages at HEAD. A cell
asserting "it throws", or even "it throws this message", passed on both buggy and fixed builds: blind
by construction while looking strict. Sibling from the same work: under a different grouping key the
defect survived with its diagnostic gone; the refuse did not throw at all. A message-matching oracle can
miss a defect because two inputs agree; a throw-counting oracle can miss one because the throw
disappears.

**How to apply:**

- Pair fixtures so one message is invariant across RED and GREEN while the other changes.
- Run the cell against the unfixed build (RED) and confirm it fails there.
- Pin the site string in the expected message (anchored regex) when the site is what changes.

Related: \[[suite-blind-on-its-classified-axis]\] \[[defect-reachable-by-two-paths]\]
