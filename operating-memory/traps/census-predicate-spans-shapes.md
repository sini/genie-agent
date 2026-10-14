---
name: census-predicate-spans-shapes
description: Applies when listing the sites a migration or refactor step must touch.
type: trap
---

**Rule:** Define a migration unit by its acceptance oracle's arithmetic, not by one grep. Say which
predicate produced each figure, beside the figure.

**Why:** A brief named four sites for a migration step. All four were real, but the list undercounted:
it was the "crossing" population, and the unit also contained "spelling" sites (same file, different
syntax, a different helper not involved). The spec's own acceptance arithmetic ("residue 7 after step
1, reaches 4 at step 4") required three more sites in one file to move: five there, not two. The
census ran one predicate; the spec had two.

**How to apply:**

- Read the acceptance cells that count residue before quoting a site list; reconcile them.
- "4 crossing sites" and "the sites this step must migrate" are different claims; keep the predicate
  name on the figure.
- Re-measure any figure before relying on it; a number from ten minutes ago predates the last relock.

Related: \[[check-output-is-not-its-population]\] \[[control-population-must-match-claim]\]
