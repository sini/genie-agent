---
name: defer-review-of-built-not-planned
description: When deciding whether a design review can wait until the system works
type: practice
---

**Rule:** Defer the deep review of what is already built until it runs. Do not defer the review of what is about to be built.

**Why:** The owner ruled "we'll deeply review design once we have a functional system, refactor is cheapish". That released a backlog in which almost all open rows rested on unreviewed design. It did not release the adversarial gate for NEW designs (spec, then gate, then validated, then implement), the "spec before development" rule, or the direct filing of measured defects.

The reason the gate survives is that "refactor is cheap" is a claim about the cost of change, not about detection. A defect that ships silently is never refactored, because nothing tells you it is there. In one arc the gate caught a diamond-shaped duplication that was exponential in output size. It was invisible to every test (the only fixture was a chain, and chains and sibling fan-ins are both trees) and it survived two adversarial rounds. The round-2 fix was verified to restore parity and was still wrong.

**How to apply:**

- Built and running: review against the running system.
- Not yet built: gate the spec before code.
- Include fixtures whose shape differs from a tree (diamonds, shared children) in any review of dedup or merge logic.

Related: \[[oracle-design]\] \[[nix-hidden-unsoundness]\]
