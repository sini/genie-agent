---
name: counts-need-anchor-and-population
description: Whenever a sentence states a number, "every", "none", "anywhere", or a line coordinate — in a report, record, brief or spec.
type: practice
---

**Rule:** A count is true only at an anchor (a sha or state), over a stated population, at a stated
granularity. Count with an untruncated command before you narrate. Ship every durable count with its
anchor, or do not ship it.

**Why:**

- `sweep 'X' | grep -v NOISE | tail -4` showed four rows and became "three hits, every one from source
  A, none from source B". The real count was 17 and the "none" was false. The predicate was right; the
  `tail` was for readability and the sentence quantified over the display.
- "Zero live dependencies ANYWHERE" was asserted over a two-path glob; the tree held 84 lock files,
  the glob covered 59, and five carried the dependency.
- A clause about "the site named above" was declared false on the strength of a peer's measurement of
  a DIFFERENT site. One `grep -rl` would have shown the named site was internal.
- An author said six sites, a reviewer corrected to seven, the orchestrator relayed seven; recounted
  uniformly it was nine or twelve depending on convention. Both originals were wrong for the same
  reason: no stated granularity.
- Two passes both said "6". They had measured disjoint populations in opposite directions (rows to
  strip a label from, rows to add it to). Both were right; a brief built on their "disagreement" was
  void.
- A reviewer's line numbers were "corrected" off-by-one from a working tree that a dispatched builder
  had just edited. Both readings were right at their revs.
- A count relayed from a review's pin-time rev (888) was wrong at the builder's HEAD (912).

**How to apply:**

- `n=$(cmd | grep -c '^- ')` for the claim; `cmd | head -5` for an excerpt; write "N total, M shown".
- Phrases like "the corpus", "the callers", "anywhere", "the site named above" are the claim's
  SUBJECT. Count the set before quantifying over it, and write the domain expression beside the
  quantifier.
- State the unit: files vs positions vs rows. Two counts in one document share a convention or are
  labelled as different units. Reconcile old and new figures; do not just replace.
- Before comparing two figures, ask "same set?" before "same number?". Carry direction where one
  exists.
- Locations: cite by binding name, and read with `git show <rev>:path` whenever anyone is writing in
  the repo (\[[cite-by-binding-not-line-number]\]).
- Prefer naming the instrument over the numeral; the instrument stays true.
- When relaying a count, carry the rev and convention, or better, carry the predicate and let the
  recipient re-derive.
- A count of 1 that is your own earlier writing is not evidence of rarity.

Related: \[[relayed-is-not-measured]\] \[[armed-controls]\] \[[scope-every-universal]\]
