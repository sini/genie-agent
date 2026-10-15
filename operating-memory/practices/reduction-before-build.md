---
name: reduction-before-build
description: When facing an aged backlog or defect frontier, before dispatching builders against it.
type: workflow
---

**Rule:** On an aged backlog, run read-only reduction passes before builder lanes. A reduction may
NARROW an item on one pass; CLOSING an item is a retirement and needs a second independent pass.

**Why:** Tracked items outlive the landings that discharge them. In one session eight reduction
targets all closed or narrowed sharply: some had zero live items, some were shadowed by retired
libraries, one found a live end-to-end defect nothing tracked (a hub's lock pinned the fix's parent).
Reductions outperformed builds per token all session. A triage row labelled "verified" the same day
pointed at a line that had drifted onto unrelated code; the fix had shipped 19 days earlier.

**How to apply:**

- Commission shape: fetch the item's body whole (the newest part governs), enumerate every stated
  item, mark each DISCHARGED (with pointer) / LIVE (on whom) / STALE-PREMISE (with the falsifying
  measurement and a firing control), and recommend close / close-with-successor / keep-narrowed, each
  with a counter-case.
- Anything ambiguous is LISTED for a reading, not silently disposed. A close that would lose a live
  remainder files a short successor.
- Tells an item is reduction-shaped: filed against a retired component; its dependents closed; a
  premise naming constructs a later ruling superseded; described in pre-ruling vocabulary.
- Re-derivation at HEAD is the first step of any dispatch built on a triage label. "Do not
  re-measure" governs expensive measurement, not the cheap does-this-site-still-exist check.
- Scope the class before auditing it: if most such items are already closed, the class is spent.
- Second pass for a close means a different context RE-RUNNING the refutation's own predicate, able to
  come out the other way. An implementer who reproduces the refutation while acting on it counts; an
  orchestrator relaying the report does not.
- Before any audit, reduction or sweep, check for prior passes on the TOPIC (not the item id), e.g.
  `ls reports/ | grep -iE 'triage|reduction|<topic>'`. Skipping it re-derives work already on disk.

Related: \[[armed-controls]\] \[[relayed-is-not-measured]\]
