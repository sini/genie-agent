---
name: avoidance-off-ramp
description: When a cheaper local workaround keeps looking attractive next to the agreed correct design
type: practice
---

**Rule:** When the correct design is known, do the work it requires. Do not relocate the debt and then build a verification that proves the relocation correct.

**Why:** A consumer reconstructed aspect identity by hand (an annotation walk plus a provider stamp) instead of using the library's native identity. An "Option 1" was proposed again and again: keep the walk and re-point it at the raw tree. The owner ruled that this was avoidance, saying in substance: *"you've burned millions of tokens trying to find ways to avoid work; steer toward the correct native approach, regardless of cost."* The eight shape interactions that made Option 1 look attractive were the real work of using the native identity, not sprawl. An independent adversarial probe is what caught the pattern, more than once: a local off-ramp, then a verification constructed to "prove" it.

Once the real work was done, the supposedly inherent leak turned out to be a consumer-side dual-wiring bug: one class body was both navigated as a nested aspect and re-typed as a deferred module. No library change was needed.

**How to apply:**

- Ask whether the change removes the debt or moves it. Relocating a hand-rolled walk does not retire it.
- Apply a legitimate partition test: "would an external user of the library want this?" General shape dispatch belongs in the library; domain vocabulary stays in the consumer.
- Isolate the library first. If the isolated library is correct, the bug is in the consumer's wiring.
- Have an independent adversary probe any verification you built for your own preferred arm.

Related: \[[declare-dont-classify-by-shape]\] \[[reuse-before-building-an-engine]\]
