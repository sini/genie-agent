---
name: suite-blind-on-its-classified-axis
description: Applies when reviewing a spec or test plan that was flagged with a risk class (ordering, identity, novel construction).
type: trap
---

**Rule:** When an artefact is classified under a review class, name the property that class protects,
then find the test that pins it. No such test is a finding, however green the suite.

**Why:** A collapse algorithm was classified "ordering semantics" because it decides by walk order which
arrival represents an element. Its spec said "first in walk order". A gate found no cell pinned that
choice: a build keeping the walk-LAST arrival passed every cell. Everything else was pinned; the one
free choice the mechanism makes had no oracle. The classification is a pointer to where to look, not a
ceremony tag.

**How to apply:**

- For each free choice the mechanism makes, write the mutant (e.g. last instead of first) and confirm
  some cell reds on it.
- Check controls pass at GREEN too: a control can be wrong like any predicate.

Related: \[[defect-reachable-by-two-paths]\] \[[assert-which-refusal-fired]\]
