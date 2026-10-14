---
name: gen-primitive-contracts
description: 'When wiring gen primitives into a consumer: the caveat each one imposes'
type: reference
---

**Rule:** Each gen primitive comes with a consumer contract that the library does not enforce. Honour it at the call site.

**Contracts (each one bit or nearly bit a consumer):**

- **gen-dispatch `produces`** is a TRUSTED declaration. Run the definition-time classify-and-stamp step first. Dispatch mis-stratifies a lie silently. The stamp checks group ≡ produces, not produces ≡ body. Never pass `produces = []`: it counts as declared, which skips validation and derives no group.
- **gen-graph `foldReach`** is first-edge-wins per target. A second edge to a visited target is dropped with its projection. When replacing a hand-rolled include walk, classify inside `expand` by frame type (uniform frame). Classify-then-recurse reorders, because the original interleaves.
- **gen-graph `all` vs witness modes:** `all` answers revisits, witness modes are acyclic-only. This divergence is deliberate; do not "fix" one to match the other. The label regex uses Brzozowski derivatives, not `builtins.match`, which avoids backtracking overflow.
- **gen-pipe `site`:** share iff same derivation. Distinct declarations need distinct sites even when structurally identical. Put sites at a chain root, or at the divergence point if chains share a prefix. Keep `#` and `.` out of site tokens.
- **gen-scope `inheritSet`:** own ∪ every ancestor, nearest first. A typed slot must not re-leak into the generic inherited context.
- **gen-bind:** an eval-time gate works through `mkIf` and cannot conditionally declare an option. A nested cross-eval strips `_module`, so the outer terminal must hold the gated keys. Error-strategy collisions surface only when `warnings` are forced.
- **gen-aspects (on gen-schema):** `flatten` forces freeform leaves to WHNF, so build registries after the fixpoint. Dispatch parametric functions on the wrapper marker, not on arity. Dedup on the structural path key. Reserve a key by declaring it as an option (`aspectModules`), not with an exclusion list.
- **gen-schema for aspects** is kind-level only. Aspects carry positional identity, so they use recursive `lazyAttrsOf`, not flat instance registries.

Related: \[[gen-capability-map]\] \[[nix-hidden-unsoundness]\] \[[declare-dont-classify-by-shape]\]
