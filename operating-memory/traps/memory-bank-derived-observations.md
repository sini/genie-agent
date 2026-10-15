---
name: memory-bank-derived-observations
description: When recalling facts from a memory service that synthesizes observations from stored facts (e.g. hindsight)
type: trap
verified: unverified
---

**Rule:** On any recalled claim about an instrument or a measurement, read its fact type first. Measured world/experience facts are evidence. Synthesized observations are hypotheses to re-derive at HEAD.

**Why / measured:**

- A derived observation inverted its source. It claimed an md5 anchor was "computed over the last three lines (head -n -3)", which is wrong twice. It also inherited the `trap` tag from the true fact it was derived from, and ranked first in recall, above both its own correction and the original measured trap. The inversion was then written into a spec as a strike-through of live text, orphaning two correct citations.
- The service refused to invalidate observations ("they regenerate from their sources"). Retaining a corrective fact does not remove or outrank the inversion.
- The bank-wide observation mission asked the extractor to "name the rules you drew on". Fed infrastructure facts, it invented twelve rule names that occur nowhere in the source. The instruction could not be satisfied for that input, and the observer sees only one small batch with no corpus and no tools. Rewriting the mission to drop the false premise, state the observer's window and allow a null result fixed it.
- Per-strategy config silently dropped unknown field names and strategy names. A typo changed nothing and reported nothing.

**How to apply:**

- Check `fact_type` on every recalled instrument claim, and re-derive observation-type claims before acting on them.
- Write extraction missions that the input can satisfy, and give them an explicit empty-result path.
- Read service config through its API and probe the envelope's shape first. See \[[json-accessor-envelope]\].

Related: \[[json-accessor-envelope]\] \[[memory-is-not-evidence-about-head]\]
