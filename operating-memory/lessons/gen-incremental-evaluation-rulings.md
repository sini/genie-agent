---
name: gen-incremental-evaluation-rulings
description: When working on incremental re-evaluation, warm overrides or rebuilders in pure Nix (gen-resolve, gen-memo, gen-rebuild)
type: practice
---

**Rule:** In pure Nix, incremental evaluation is a constant-factor win with honest ceilings, not O(affected). Over-declare dependencies, use a cheap sound over-approximation of the reverse cone, and gate reuse on byte parity against a cold run.

**Why / measured rulings:**

- True total minimality is unreachable in one pure Nix evaluation. Three propagate variants were raced on a counted-forces harness. Eager rank-ordered push won on the expensive axis for edits that cut many nodes, but total work stayed above O(|cone|) everywhere, because the rank precompute and the sweep are themselves O(|cone|). Breaking that floor needs cross-evaluation persistence, which is out of scope. Deep constructive traces go quadratic in the cone. The contract says "constant-factor win, byte-identical", and keeping that honesty was the point of the exercise.
- Warm override uses the topological reverse cone (gen-graph `dependentsOf`), not exact hash-detected AFFECTED. Exact detection measured ~2x the dominant spine cost and pays off only across evaluations. AFFECTED is a sound OVER-approximation; do not call it "the reverse cone" in theory text.
- Declared edges MUST over-declare cross-node reads, or a consumer outside the cone is served a stale value on override.
- A class key is a conservative narrowing key. Sound reuse also needs definitions to be disjoint, closure under the fixpoint, and a byte-identity gate. It is a post-eval confirm, dual to a pre-eval predict key.
- gen-resolve owns the stratum CHECK and the consumer owns the LABEL. An explicit stratum is honoured for any kind, and narrowing that to "synthesized only" would break a consumer.
- Parametric arguments must be defunctionalized to data before any keyed attribute, because a function sentinel erases the closure's argument shape.
- Stated gaps that stay stated: full drain rather than per-edge, support/retract faithful in name only, SCC monotonicity unchecked (iteration cap only), condensation O(n²).

Related: \[[nix-hidden-unsoundness]\] \[[oracle-design]\] \[[declare-dont-discover-boundaries]\]
