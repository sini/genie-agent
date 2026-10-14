---
name: parity-with-a-reference
description: When a new implementation must match a reference implementation (nixpkgs, a v1) and they disagree
type: practice
---

**Rule:** Before ruling "match the reference" on a case, find out why the reference answers as it does. Treat the reference's result as a rebuttable presumption, not as law.

**Why / measured:**

- A ruling "the reference refuses, so we refuse" was made on one cell. That cell was a doubled default, which the reference refuses for its own reasons and the new design had deliberately accepted. The builder correctly declined to build it. The owner's parity requirement covered the serve direction (where the reference serves and we refuse by name, we serve its value), not the refuse direction.
- Generalizing an owner statement about one regression into "both directions" was caught as not being the owner's words. Record exactly what was said.
- Serving beyond the reference is allowed only where it never costs correctness. A newly served case must enforce every declared check of both sides, and a planted value that either side's check rejects must be refused. A serve that drops a check fails, even if the reference drops it too.
- For unmodified user modules, the old system's delivered value is a rebuttable presumption. Classifying it as "the old system is wrong" needs a value forced by law, a cell showing the invariant it breaks, and an adversarial gate. Any reasonable counter-argument goes to the owner.
- Parity is byte equivalence where the reference is correct, not identity. Merge order need not match, and a known-buggy reference is not a golden corpus.

**How to apply:**

- Before recommending an arm that is cleaner for the native path, count the parity cells it regresses, both in native evaluation and in a foreign host.
- Cite parity only in the direction that was ruled.

Related: \[[oracle-design]\] \[[module-system-reimplementation-divergences]\]
