---
name: cite-the-primary-honestly
description: When documentation or code cites academic theory, a theorem, or another library's guarantee
type: practice
---

**Rule:** Cite what the primary actually states, at the precision it states it. When a question turns on a paper, send a fresh agent to read the paper itself rather than reasoning from a citation chain.

**Why / measured from repeated conformance audits:**

- The load-bearing theory was sound everywhere; the defects were provenance hygiene. That is still worth fixing.
- A phantom "Theorem 5.12" (Palmer 2024, intensional functions) propagated across many rows. The paper has only Theorems 1 and 2; the real coordinate was Lemma 5.12, and it does not state the soundness result attributed to it.
- Cycle detection was cited to a paper that proves no such thing. A transitive-reduction cite supplied only the equivalence notion, while the algorithm's DAG precondition went undocumented.
- A uniqueness theorem assumes a static graph. Interleaved construction ships a detector, not a guarantee. The result that applies is the one for incomplete graphs.
- Docs claimed a commutative idempotent semilattice where the shipped combine was `a ++ b`, which is only associative. Determinism came from a pinned traversal order. Swapping in a commutative combine would silently reorder ordered collections.
- ∆-Nets (Salvadori 2025), examined in three workflows, turned out to be a foil, not a foundation. The durable output was a citation rule (for "no wasted work", cite Lévy 1978 and Barendregt 1987), and a proposal to add foil citations as support was rejected as provenance pollution.
- A justification read "conservative / safe by monotonicity", but name-only equality dedups more than the paper permits. It is sound only because naming discipline is contracted, so the docs say it implements the structure, not the theorem.
- One circulating "PDF" was an HTML landing page.
- A positional last-wins fold is the honest realization of "policy decides last". Mature systems make precedence per declaration. State the constraint; do not dress the ordering up as a principle.

**How to apply:**

- For each cited result, list its preconditions as satisfied, violated or unknown, and check that the cited section actually contains the content.
- Put honest ceilings in code and docs. An "informed by" register is fine.

Related: \[[pdf-text-extraction-traps]\] \[[nix-hidden-unsoundness]\]
