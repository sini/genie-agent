---
name: scope-by-membership
description: When defining the population for a sweep, census, propagation or class fix across many repositories or files
type: practice
---

**Rule:** Cut a class by MEMBERSHIP, then measure it by PROPERTY, not the reverse.
Membership is read from the project's register and decision records, not inferred from a
roster file, a directory listing or a text grep. Archived and retired repositories are out of
scope of every ask.

**Why:** a lockfile convergence was scoped as "every lock holding dependency X at the stale
revision". It swept five repositories the work did not own: two excluded by a decision record,
two off-roster tools, and one absent from the register entirely. The register and the records
existed the whole time and were not consulted. Three of the five broke when a dependency edge
moved, the breakage was filed as top-priority blocking work, and a fourth consumer was
dispatched before the owner stopped it. A wrongly cut class does not just waste a sweep; it
manufactures a queue. Separately, agents kept reporting findings on archived repositories,
and each one cost attention to dismiss. Owner: "the deprecated/archived repos shouldn't be in
any scope of any ask."

**How to apply:**

- Every brief for a census, sweep, consumer run or class fix states its population as the
  live tree and names the exclusions.
- "Not on the roster" is the wrong test in both directions. A harness library was core without
  being on the roster (named by 21 of 21 members), and some excluded repos were not marked on
  it.
- Do not derive membership with a text predicate. One range-grep returned 53 entries,
  including its own enclosing bindings.
- A finding that concerns only a retired repository is dropped, not filed.
- If it already happened, do not revert harmless off-scope work (reverting spends more
  off-scope effort). Record it, stop spending there, and re-derive the remainder under both
  scopes.
- Do not dispatch into an open scope question. A mid-round stop message rarely reaches a
  working agent in time.

Related: \[[generic-core-no-consumer-names]\] \[[armed-controls]\]
