---
name: generic-core-no-consumer-names
description: When scoping a framework's feature surface, or naming types and mechanisms in a generic library or framework core
type: practice
---

**Rule:** A generic core ships generic mechanisms. Consumers name specific tools on top. The
feature target is the full surface of what the system is meant to express, not whatever one
sample configuration happens to use.

**Why:**

- A reimplementation kept calibrating against one user's configuration repository and
  deferring features because "no config uses this". User configs are a LOWER bound on the
  surface in use; private configs are invisible. "No corpus witness" is not a valid reason to
  defer. "The system cannot express this" is.
- A kernel grew N tool-named output types (one per deploy tool), all structurally identical.
  The owner's question: "why multiples, not ONE system?" The answer was to collapse them into
  one generic output-family mechanism whose family name is a data label the consumer supplies.
- In toolkit design work, the owner corrected framings like "the framework's layer": "we're
  building a generic framework toolkit."

**How to apply:**

- Scope by expressibility over the system's own surface. Use configs to prove a gap is real,
  never to set the ceiling.
- In core code: a tool name as a string DATA label is fine, and documentation references are
  fine. A hardcoded kernel TYPE or binding named for a consumer tool is a violation. Test with
  synthetic, generic fixtures.
- N structurally identical named entries is a smell: collapse them into one mechanism.
- In a toolkit's design text, speak of "the graph layer", "a framework's base kind" or "the
  target's own evaluator". A downstream framework appears only as a measured example corpus.
- Fix genericity before adding new coverage.

Related: \[[design-bar-theory-not-compat]\] \[[scope-by-membership]\]
