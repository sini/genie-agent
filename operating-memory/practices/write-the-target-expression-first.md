---
name: write-the-target-expression-first
description: When scoping or dispatching a design, especially one framed as "retire X" or "replace X".
type: practice
---

**Rule:** Write the answer first, stated directly, and judge its size. Frame the work by its
destination, never by the construct being removed.

**Why:** A design dispatched as "retire the per-class content bucket" organised itself around the
bucket: its vocabulary, its cost, what survives its retirement. Four review rounds and 1525 lines
later, the actual answer was a two-line query:

```nix
classSeedsAt = frame: n: exempt: injects: c:
  prelude.concatMap (raw n exempt injects) (srcOrder frame c);
```

The owner had described it correctly from the start ("a graph of nodes, and resolution is a query
across them"), and nobody checked the artefact against that sentence.

**How to apply:**

- Frame the dispatch as "express X as a query over relation R", not "retire the bucket". The frame
  chooses the document's subject.
- Ask for the expression in the first round. Two lines means the rest is scaffolding, reviewable on its
  own terms; two hundred means the model is wrong.
- When the owner states the concept in one sentence, check the artefact against that sentence. It is
  a specification and the cheapest correctness check available.
- Review a design until it is implementable, then let tests finish it. Three of four review rounds in
  that case found code defects a red test would have caught faster. Reserve full adversarial review
  for what a test cannot express: semantic forks, entanglement with retiring constructs, claims about
  what a guard judges.

Related: \[[reuse-scan-before-build]\] \[[spec-and-plan-before-code]\]
