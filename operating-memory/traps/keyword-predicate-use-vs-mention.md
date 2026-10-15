---
name: keyword-predicate-use-vs-mention
description: Applies to scripts that classify tracker rows or documents by keyword (e.g. "needs an owner reading").
type: trap
verified: unverified
---

**Rule:** Treat a keyword-predicate hit as "the text contains the vocabulary", never as "the row is in
that state". Confirm by reading the row. Test the predicate with GENERATED positive and negative
fixtures per grammar family, not only corpus quotes.

**Why:** A sitting-agenda script flagged rows that ask for an owner decision by phrases like "owes an
owner reading" or "to the owner sitting". Rows that NARRATE that a reading was owed, asked or answered
use the identical words. After widening the vocabulary from 4 spellings to 3 grammar families, a gate
wrote 28 non-asking sentences and 21 still read positive. The asymmetry is deliberate (a false
positive costs a glance; a false negative drops an owner obligation silently), but it must be known.
Separately, a mutant that disabled the negation guard for two families passed every corpus-quoted
fixture, because those families had zero negated occurrences in the corpus.

**How to apply:**

- Reserve the vocabulary: write it only when asking; paraphrase when narrating.
- For each grammar family, generate asking and non-asking sentences and a negated form; assert each.
- Run mutants against the fixture set to prove it discriminates.

Related: \[[suite-blind-on-its-classified-axis]\]
