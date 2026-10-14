---
name: gen-theory-rulings
description: When writing or reviewing gen documentation that cites theory (standing, do-not-relitigate rulings)
type: reference
---

**Rule:** Use these settled groundings. Re-open one only with a primary-text reading that contradicts it.

**Standing rulings from the gen theory-conformance audits:**

- **intensionalEq is name-only, and that is the deliberate ceiling.** gen's closure is programmer-declared, not compiler-extracted, so neither name-only nor name-plus-closure equality is faithful to the paper's Theorem 1. Docs say gen implements the STRUCTURE of Palmer 2024's intensional functions. The old "conservative / safe by monotonicity" justification was backwards: name-only dedups MORE than the paper permits, and is sound only by contracted naming discipline.
- **Palmer 2024 has no Theorem 5.12.** Cite Lemma 5.12, Theorem 1, Def 5.6.
- **Guard/arg wrapping is reflection, not Reynolds-style defunctionalization.** The arrow survives inside `__functor`. The only correct Reynolds use is the obligation on consumers to defunctionalize arguments to data.
- **Observational congruence** is Morris / Plotkin / Pitts, not Reynolds 1972. This was verified against the primary after the circulating PDF turned out to be an HTML landing page.
- **Néron 2015 uniqueness assumes a static scope graph.** Interleaved build-and-resolve ships a detector. Cite van Antwerpen 2016 (Statix §4.3) for soundness over incomplete graphs.
- **Pipe determinism is not Kahn.** Multi-writer gathers violate the single-writer condition. The shipped collection combine is `a ++ b` (associative only), and determinism comes from a pinned traversal order plus a left fold. Never swap in a commutative/idempotent combine for ordered collections.
- **For "no wasted work", cite Lévy 1978 and Barendregt 1987**, never ∆-Nets, which is a foil (optimality there is anti-parallel and the workload does not match).
- **Misattributions corrected:** cycle detection is not Vogt 1989; construction-time argument injection is not Bracha–Ungar Mirrors; transitive reduction needs its DAG precondition documented, because Mokhov supplies only the equivalence notion.
- **Acyclicity gates are Knuth-only**, not Vogt higher-order attribute grammars.

Related: \[[cite-the-primary-honestly]\] \[[pdf-text-extraction-traps]\]
