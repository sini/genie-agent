---
name: read-the-system-not-the-story
description: When reconstructing how an existing system works, or consulting older design documents
type: practice
---

**Rule:** Read the system's own extracted artefacts and source before theorizing. Treat old design documents and self-written audits as testimony, not authority.

**Why / measured:**

- A framework already extracted its own graph IR for diagram rendering. Reading that IR answered topology questions that were otherwise being reconstructed from internals. It also exposed that an earlier size note was off by 4x (the file was 1.3 MB, not ~93 KB, so do not `cat` it). Nodes were not only entities: entity-to-scope was 1:1, while entity-to-node was 1:many.
- An original design-spec corpus for an older implementation had had zero consultations for months, while a thesis it stated in prose was re-derived from scratch by measurement. The owner ruled it testimony only: consult a single document when a live question needs the old system's intent, filter it through current criteria, and never import its mechanisms (state accumulators, marker keys, effect handlers).
- A self-authored audit catalog was self-exculpating. A large adversarial workflow (62 raw findings, 25 confirmed, 33 refuted) produced the trustworthy roadmap.
- Two common recollections about the older system ("classes are terminal", "flake-output classes are opt-in") were both wrong against its source.

**How to apply:**

- Look for an existing IR, trace or export before writing a probe. Read its key sets and counters with a script, never by dumping it.
- Quote the old system's behaviour only after a source read at a pinned revision.
- Run audits adversarially: steelman the defence, and keep only the findings that survive.

Related: \[[reuse-before-building-an-engine]\] \[[cite-the-primary-honestly]\] \[[memory-is-not-evidence-about-head]\]
