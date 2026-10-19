---
name: drive-work-from-the-acceptance-bar
description: When a parity or compatibility backlog keeps growing from synthetic test grids faster than it closes
type: practice
---

**Rule:** Order parity work by the acceptance bar (the reference's own test suite first, then real
consumer configurations), not by synthetic census grids. A grid is a regression guard; a grid cell
becomes a work item only with evidence the shape occurs in real material. Group items that share a
code site into one combined delivery.

**Why:** The per-item spec, gate and build loop over synthetic grids grew the backlog faster than it
closed it. Owner: "Why is it taking us so long to adapt these edgecases? Are we overcomplicating it?"
and "We can deviate from the process for this mini-arc if it helps us ship a better product." Driving
from the reference's test suite with combined deliveries landed nine units in a day. Separately, a
structural "delete the machinery" shortcut measured over the grids and the bar together showed 1,087
regressions.

**How to apply:**

- Keep one queue ordered by the bar's stages; record which bar failure each item clears.
- Before recommending a structural shortcut, measure it over the guard grids AND the bar.

Related: \[[reduction-before-build]\] \[[backlog-is-one-defect]\] \[[parity-with-a-reference]\]
