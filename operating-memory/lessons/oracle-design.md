---
name: oracle-design
description: When building a parity, equivalence or regression oracle that will gate changes
type: practice
---

**Rule:** Make the oracle observe the production object itself, pin its reference permanently, and pair structural parity with a content hash.

**Why / measured:**

- Making production delivery render the same edge object the parity oracle checks turned the claim from "new ≡ oracle" (weak) into "new ≡ old pipeline". Production became the parity trace.
- Structural edge parity records identity, not content. It needed pairing with a content gate (a toplevel derivation hash), and that hash had to be comparable across pipelines.
- The golden reference pins of a byte-parity oracle (gen's `-orig` witness inputs) are frozen forever. Rotating them does not update the oracle, it vacates it, because the thing being proven equal moves with the thing proving it.
- An identity re-route had to pass a partition regression (same path gives the same id, distinct paths give distinct ids). Literal string equality was meaningless, since a hash cannot equal a path string.
- An equivalence oracle against the reference module system belongs at the terminal. The intermediate cascade is deliberately last-wins, which is not the reference's priority order.
- "Fixed" was made to mean "the built system did not move": the consumer's `drvPath` was compared before and after.
- A proof whose fixture only exercised plain values could not discriminate a lock bump. Assert on the value that only the new behaviour produces.
- A residual legacy path kept alive only as a standing equivalence gate is legitimate. State that it retires once trust is established.

**How to apply:**

- Run byte-parity oracles as permanent CI, not one-off proofs.
- Give every oracle a must-FAIL row run against the alternative it is meant to reject. Discriminating power is a property of the triple (fixture, alternative, parameters), not of the fixture.

Related: \[[parity-with-a-reference]\] \[[confirm-baseline-before-claiming-a-gap]\] \[[controls-for-absence-claims]\]
