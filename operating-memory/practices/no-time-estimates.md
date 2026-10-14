---
name: no-time-estimates
description: When sizing work, scoping a plan, or asked "how big is this".
type: practice
---

**Rule:** Never give a duration (days, hours, "sessions"). Size by delivered shape: artefacts, lines
of code, files/repos touched, risk tier, oracle surface, whether a spike is needed.

**Why:**

- An LLM delivers much faster than human-calendar estimates imply, so the number is misleading and
  frames the work on the wrong axis.
- The error has a direction: anchoring on a theoretical category ("a type system", "an incremental
  rebuilder", "an attribute-grammar evaluator" all sound like research projects) over-estimated by
  roughly 10x. Several such libraries, with dozens to hundreds of tests each, shipped in about two
  days each. A module-system re-host tagged "weeks to months / keystone / dominant cost" was a
  provider swap over existing pure code.

**How to apply:**

1. Decompose to concrete artefacts (vendor N LOC, an M-item primitive, a protocol swap, TDD against an
   oracle). Count available reference implementations. Then size.
2. Report: "MODERATE risk, ~40 LOC, touches the core library and 3 callers".
3. The real risk axis is usually external-oracle surface completeness (a 7-item primitive turning out
   to need 8-9 once the equivalence oracle runs). Report that as a risk tier and a named uncovered
   surface, not as added time.
4. Strip durations from scope docs, plans and briefs, and tell scoping agents to size by shape.

- Tell: you are writing "weeks-months", "keystone", "long pole". Stop and recompute from the shape.

Related: \[[orchestrate-against-theory]\]
