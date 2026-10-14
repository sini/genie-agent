---
name: scope-every-universal
description: Before finalising design prose or a report — every "every/any/always/never/only/cannot", and the one sentence that decides what the report is about.
type: practice
---

**Rule:** Treat every universal quantifier in your own draft as a defect until you have scoped it.
And find the framing sentence of every report (its scope, its owner, what is out of play) and ask
what measurement would falsify it.

**Why:**

- Three claims failed in one spec arc, each after the work had been done correctly: "reachable ONLY
  through `get`" (the accessor also exposed raw records); "a value the type does NOT admit" (the
  language has no static types); "byte-parity holds for EVERY possible decision" (false on a second
  axis). The narrow claim was true every time and was stated wide. Twice the wide claim contradicted
  another clause, once making an oracle look pointless.
- "Our CI exercises the flake path only" was repeated to a peer and banked. False: one template
  declared no such input, so eight cells ran the fallback path, and those were the cells that caught a
  break the main path read green on.
- "The library ships no X by design, so injecting X is not available" was true of the library and
  settled nothing: the consumer had X. It rode inside a rigorous report and decided who owned the
  defect.
- A pass found a real stale table and invented a mechanism to explain it. The mechanism was banked as
  law before review; review refuted it on the document's own text. The observation needed no defence;
  the mechanism did.

**How to apply:**

- For each universal: what is the widest thing this now says? Narrow it to the axis you established,
  or name the excluded axis in the same breath. Prefer "over axis X, ..." to "always".
- Where a construction protects one axis and not another, say which and why. An unqualified safety
  claim reads as "no oracle needed".
- Self-check: grep your draft for the quantifier words and re-read each at its widest.
- Report framing tells: an absolute over a corpus ("only", "every", "no consumer"); a true but
  irrelevant "X cannot do Y" offered as if it answered "can Y be done". Measure it or mark it as an
  assumption.
- An explanation that arrives WITH a measurement and generalises it into a law is the thing to review
  hardest. Ask what the law would have predicted the day before.

Related: \[[armed-controls]\] \[[counts-need-anchor-and-population]\]
