---
name: prerelease-drop-retired-fields
description: When retiring a field, option or export in a library that has not yet had a public release.
type: practice
---

**Rule:** Pre-release, a retired FIELD or option is dropped outright: no tombstone, no retired list.
A renamed EXPORT still keeps a refused-by-name alias through the migration. Final documentation must
be consistent and point to where the capability now lives.

**Why:**

- Owner: "We're still pre-release so are under no obligation to carry retired fields; we can make a
  breaking change so long as the final documentation is consistent." The owner picked an arm that had
  not been offered (keep vs split were offered).
- An earlier version of this rule said "field, option or name", wider than the ruling. A build then
  dropped seven export aliases on that basis and was caught at review.

**How to apply:**

- Retired field: offer "drop, and docs point to the replacement" and recommend it by default.
- Renamed export: plan the full alias/tombstone so callers get a named refusal, not a missing attribute.
- Documentation does not describe never-shipped or retired features. A stale name on a docs page is an
  inaccuracy to fix, not history to explain.
- The rule stops holding once the library releases.
- When writing down a ruling, scope it to the words ruled; a wider paraphrase gets executed.

Related: \[[recording-owner-rulings]\]
