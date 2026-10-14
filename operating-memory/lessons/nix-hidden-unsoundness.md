---
name: nix-hidden-unsoundness
description: When writing incremental, dedup, hashing or traversal code in pure Nix
type: practice
---

**Rule:** Assume dedup, hashing and "clean" checks are unsound until a test with function-bearing, multi-definition and multi-seed fixtures shows otherwise.

**Why / measured:**

- Null-hash false-clean: `null != null` is false, so a changed function-bearing node whose hash is null reads as reusable. Route every hash comparison through one null-safe guard. Integer-valued property tests cannot catch this; it needs function-bearing fixtures.
- `functionArgs` cannot see `@`-patterns or bare lambdas, so inferring a module is clean from its formals is unsound. Treat function modules as dirty by default, with an explicit author marker as opt-in. The suite includes a lying marker to prove the guard has teeth.
- Dedup on the structural path key, not the name-only identity key, or multi-definition entries double-emit.
- `flatten` forces freeform leaves to WHNF, so registry builds must run after the fixpoint or self-output recursion returns.
- gen-graph's `foldReach` is first-edge-wins: it drops a second edge to an already-visited target, including its projection. Two same-target edges with different filters do not compose.
- A dedup key that must be "share iff same derivation" cannot be made automatic in pure Nix (lambdas are unhashable). It needs a caller-threaded site token (gen-pipe's `site`), placed at the point where chains diverge.
- A single-key shadow approach worked only because suppression happened to sit at one root. A true self ∪ ancestors union (gen-scope `inheritSet`) fixed the latent bug of dropping the farther suppressor.
- A warm-serve path is correct only if declared edges over-declare cross-node reads. Otherwise a consumer outside the cone gets a stale value.
- A multi-seed implementation committed before its multi-seed tests shipped a single-seed soundness bug.
- Same-priority, same-order list definitions merge in reverse declaration order.

**How to apply:** Write the adversarial fixtures before the implementation. State honest ceilings in code and docs (for example "O(|cone|), not O(|affected|)").

Related: \[[nix-laziness-design]\] \[[oracle-design]\] \[[cite-the-primary-honestly]\]
