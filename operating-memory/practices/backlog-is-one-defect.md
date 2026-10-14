---
name: backlog-is-one-defect
description: When a large backlog accumulates, when selecting next work, or when reporting progress
type: practice
---

**Rule:** Cluster the backlog by FAILURE SHAPE, not by file or area. Treat the dominant cluster
as witnesses to one representational fact, and select next work by which instance most
sharpens that representation. Run a closure sweep every session.

**Why:** the owner gave the same correction three times ("you're approaching it with the
wrong lens"). Clustering 243 open items by shape gave:

| shape                                    | count |
| ---------------------------------------- | ----- |
| something disappears and nothing says so | 96    |
| a guard admits what it should refuse     | 49    |
| the result depends on sequence           | 71    |
| one fact derived two ways                | 27    |
| missing means something, undeclared      | 26    |

Over-match controls: a rare word matched 2 items and a common word matched 87 of a different
shape; 32 items carried "silent/vanish" in the title alone. The same shape appeared at every
layer (kernel, CI, compatibility, library), which makes it representational: "nothing here"
and "something was removed here" were the same observation. A representation where absence is
a DECLARED state makes all 96 loud at once.

**How to apply:**

- Never choose work by which files don't collide. That is an orchestration convenience, and
  choosing by it is the tell that you have stopped thinking about the system.
- Red tests and corpus failures are acceptance criteria, not work items. Root-cause them only
  if they survive after the known defects are addressed.
- Do not perfect the instruments while measured defects sit. Four spec tracks reached
  revisions 8 to 10 while 243 defects sat open, and the gates were finding defects in the
  documents' own review apparatus. The tell: "this is a defect in the review instrument."
- **Closure sweep:** enumerate open items marked resolved/rescoped/expired plus whatever this
  session's landings discharged. Verify each at HEAD with a read-only scout. Close only on a
  witness. Retitle what is live but misstated. Merge duplicates, moving priority, labels and
  edges to the carrier. The first sweep closed 13 and retitled 8.
- Report progress as closure rate, critical-path length and suite-green growth, never as a
  raw count.

Related: \[[absence-is-a-decision]\] \[[integration-validates]\] \[[filing-caps]\]
