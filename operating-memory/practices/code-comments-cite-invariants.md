---
name: code-comments-cite-invariants
description: When writing or cleaning up code comments — what stays (theory citations, invariants) and what goes (task keys, plan references).
type: practice
---

**Rule:** Code comments state the general invariant or cite the academic source. They never carry
temporal task keys. During cleanup, keep valid provenance citations; fix wrong ones at the source.

**Why:**

- Agents leak their working vocabulary into comments: `#8`, `R5`, `Task 2`, `★ BLOCKER`, stash names,
  commit SHAs, "the plan says...". These help review and rot after: a future reader cannot decode them.
  The keys read naturally to the implementer because they ARE its mental model, so they leak
  repeatedly; a sub-step letter suffix (`4c-iii-C`) slipped past the first grep pattern.
- Comments citing an in-flight working spec ("Spec 2026-06-23 §5.P0") were rewritten to the library
  idiom ("Tarjan 1972 / Kosaraju for SCCs; Mokhov 2017 §4 for the quotient-graph idiom"). Transient
  planning docs rot; papers do not.
- In a library built on formal foundations, a citation like "Reynolds 1972 defunctionalization" or
  "Paper §2.2" connects the implementation to its theory. It is not noise.
- A wrong citation copied from adjacent code is a replicator: three independent-looking occurrences of
  one unchecked read. A library shipped a wrong section number after a review had ruled the right one.

**How to apply:**

- Per task, after formatting and before commit/report, grep the touched files for the arc's key
  patterns (for example `git grep -nE '\b(T[1-8]|F[1-6]|WS-[A-Z]+)\b' <files>`) and strip them from
  code comments. Keep durable spec vocabulary (a section-anchored ruling, an established taxonomy).
- Replace a temporal reference with the invariant it was protecting, or a pointer to the reference
  documentation section.
- Cleanup classes: provenance citation (keep); wrong citation (fix at the SOURCE comment, then the
  copies, or they regrow); stale dev notes like "added in later tasks", "open question #1", line
  numbers (remove); comments describing what a consumer does rather than this code (remove).

Related: \[[public-artifact-hygiene]\] \[[claims-travel-chase-the-carriers]\] \[[docs-are-part-of-the-change]\] \[[cite-by-binding-not-line-number]\]
