---
name: defect-reachable-by-two-paths
description: Applies before choosing where to fix a defect that a regression test pins.
type: trap
---

**Rule:** Before choosing a fix locus, trace by hand the call path the ORACLE (the regression test)
actually takes. The description says where a defect lives; the trace says which door the test walks
through.

**Why:** A merge defect was framed, in a bead and in a sibling spec's table, as reached through one path
(a type-merge fold, site A). An author traced the committed regression cell by hand: it called the
type's merge closure DIRECTLY, through a synthesized interface closure (site B). Both bottom out in the
same closure and are independently reachable. A site-A-only fix self-tested clean at 461/461 and the
committed cell stayed RED. The obvious repair at the shared closure was ruled out by the library's own
boundary test, which existed to forbid exactly that.

**How to apply:**

- Write down the oracle's call chain, from the test expression to the defect site.
- Where two paths reach one closure, a fix at either fixes one path. Say which the oracle uses and
  whether the other is reachable in real use.
- Drive a candidate fix rather than reasoning about it; the suite (including boundary tests) answers.

Related: \[[assert-which-refusal-fired]\] \[[suite-blind-on-its-classified-axis]\]
