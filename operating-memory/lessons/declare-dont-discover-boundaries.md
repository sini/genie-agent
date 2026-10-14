---
name: declare-dont-discover-boundaries
description: When designing caching, sharing or memoization across many similar units (hosts, configs, builds)
type: practice
---

**Rule:** Declare the invariant boundary (for example a host class keyed by its sorted feature set), then validate per class. Do not discover sharable work per element at run time.

**Why / measured:**

- Sharing evaluation results across scopes in pure Nix by per-element sentinel discovery was a rigorous NO-GO:
  - A per-element sentinel forces an invariant N+1 times against vanilla's N, because Nix memoizes nothing across separate module fixpoints.
  - A union sentinel over-throws and flips `tryEval` branches, so it admits unsafe cases.
  - Presence and structure queries are unsound even per element, because a value-throw sentinel never perturbs key presence.
  - Memoizing by syntactic path set is unsound, because the key is derived from values.
- The owner bounded that result: it held for the architecture as designed (discovery). A later module system that declared fixed class-core inputs and memoized warm overrides reached more than 70% memory reduction. At fleet scale with declared classes the sign flips.
- Soundness of discovery is intrinsic only for the subclass where throws are observed. Non-forcing channels (loose types, option-shape reads) have no pure detector, so a parity gate is a mandatory backstop.
- drvPath equality proves that output is shareable, not that evaluation work was shared.

**How to apply:**

- Use the owner's value test: does the mechanism make the open case affordable (unit A reads unit B's resolved config)? Closed record emits need none of it.
- Cost the declared form as O(K) per class, which is independent of N. Discovery is O(N) and usually net negative.
- Report a negative result with its exact scope, so it is not later cited as a blanket ceiling.

Related: \[[measure-where-the-cost-is]\] \[[oracle-design]\]
