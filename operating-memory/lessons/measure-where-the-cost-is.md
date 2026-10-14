---
name: measure-where-the-cost-is
description: Before optimizing an evaluator, framework or build, or when citing someone else's speedup
type: practice
---

**Rule:** Decompose the cost before choosing a lever, and quote a speedup only with the shape it was measured on.

**Why / measured:**

- One host's ~36 s evaluation was 94% intrinsic derivation construction. The framework was about 2.8% and the whole module machinery about 5.6%. An earlier recollection had this inverted.
- Wall time was bound by single-threaded evaluation (~63% serial eval, ~30% IO, ~6% GC). GC knobs cut cpuTime by 42% but wall time by only 6%.
- A parallel-eval flag was accepted by one evaluator and did nothing. The ~3.7x came from a different evaluator. A larger initial heap bought ~7%. Streaming and force-and-drop did not lower peak RSS, because the GC does not return memory to the OS.
- Owning `evalModules` through a lib extension cost +9 primops and +0.24% thunks, i.e. almost nothing. That measurement redirected a whole program away from the engine and toward the fleet axis.
- A competing module system's 3–10x was single-config, intra-eval, on synthetic modules that do not import the package set. It did no cross-host sharing, and above ~2400 modules it was slower because of an O(N²) tail. Its README described a mechanism the source did not implement.
- Repeated `++` inside a `foldl'` is hidden quadratic in Nix. An "optimization" in that form was measured far slower than the code it replaced, so the in-code comment saying so is load-bearing.

**How to apply:**

- Count copies or allocations by phase before acting. Look for the metric that discriminates: here, copies did, function calls did not.
- Read the source, not the README, before citing a mechanism.
- Carry the fixture shape with every figure you relay.

Related: \[[nix-eval-cost-counters]\] \[[declare-dont-discover-boundaries]\]
