---
name: control-population-must-match-claim
description: Applies to every absence claim ("X appears 0 times") and every relayed control figure.
type: trap
verified: unverified
---

**Rule:** Run the positive control on exactly the population the absence claims, and make the figure
and its population travel together as one token everywhere it is quoted.

**Why:** Two measured cases:

- A sweep reported "`adapter` => 0 files across the whole tree, controls `link` 7, `origin` 7,
  `facet` 5". The absence was whole-tree (47 files); the controls were `lib/`-only (9 files). Whole-tree
  the controls read 34, 27, 16. The spec stated both scopes once correctly, then repeated the bare
  figures without the qualifier, and the bare form propagated into a dispatch premise and a commit
  message.
- A sweep globbed `specs/adr/0031*.md` to find an amendment. The amendment lived in
  `specs/adr/ledger/0031-*.md`, a directory the glob never matches. By house style the law file carries
  no amendment vocabulary, so the search could never hit, and a positive control run in the same
  too-narrow domain passed. An agent was then dispatched to draft an amendment that had landed 20
  hours earlier.

**How to apply:**

- Write `link 7 (lib/ only)`, never `link 7`. When relaying someone else's controls, re-derive the
  population or mark the premise as relayed.
- Before an absence search, ask where the thing would live if it existed, and include that location.
  For a document stored as two records (law + ledger), glob both.
- Add a random negative control (a fresh string from `/dev/urandom`) beside the positive one.
- If the conclusion survives re-measurement, still record that the original basis failed.

Related: \[[control-must-differ-on-the-failing-axis]\] \[[controls-for-absence-claims]\]
