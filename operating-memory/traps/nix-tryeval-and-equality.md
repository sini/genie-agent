---
name: nix-tryeval-and-equality
description: When a Nix probe or test relies on builtins.tryEval or on == between values
type: trap
---

**Rule:** `tryEval` catches only `throw` and `assert`, and `==` cannot compare functions. Design probes and guards around both limits.

**Why / measured:**

- `tryEval` does NOT catch: missing attribute, `attrNames` over a list, type errors (`1 + "s"`), `head []`, coercion errors, `toJSON` on a function, an invalid regex in `builtins.match`, `lib.fix` black-hole recursion, stack overflow, or parse-time failures. Each one kills the whole evaluation, including sibling fields, so the probe looks like a crashed instrument rather than a finding.
- `tryEval` forces only to WHNF. Thunk throws deeper inside a value escape it unless you `deepSeq` first.
- `==` on functions: bare `f == f` is false. Values that CONTAIN the same function (`{ v = f; } == { v = f; }`, `[ f ] == [ f ]`) compared true on Nix 2.34.8 (measured 2026-10), so the result depends on sharing and version. Do not use `==` on values that may hold functions: a single-arm run can give a confident, exactly wrong "they differ" or "they match".
- `length` / `attrNames` force only the spine. A number quoted from them may never have touched the values.

**How to apply:**

- Make the underlying function total and put the abort beside it, rather than making the function abort. Route possibly-missing lookups through a `mustGet` that turns "attribute missing" into a named `throw`. A partial function's mutation is an uncatchable crash; a total function's mutation is a value a named check can observe.
- Count unnamed kills under mutation as a coverage defect.
- Detect function-bearing values structurally before hashing or serialising them.
- Guard divergence with located prechecks and an iteration cap. Never try to catch recursion.
- To show one binding is another, read the source at the pinned revision (an `inherit` line is proof), not `==`. Compare names or scalars, never records that carry functions.
- Use `deepSeq` plus an aborting sentinel to prove a force reached the values.
- An arm that does not exit 0 is a failure, never a datapoint.

Related: \[[nix-regex-traps]\] \[[nix-eval-cost-counters]\] \[[nix-hidden-unsoundness]\]
