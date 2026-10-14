---
name: fix-the-producer-first
description: When a defect shows up at many consumers, or a fix is proposed that teaches N readers to work around something.
type: practice
---

**Rule:** Look at the producer before guarding the consumers. A value that misdescribes its own
constructor is the defect; N defensive readers are a repair.

**Why:** A recommended fix had every gen `typeMerge` export learn to see past a partner's functor. The
owner asked to "consider this more deeply from the other side" and to scout first. Re-derived from the
producer: `gen-schema`'s `refined` presented its BASE type's functor (copying nixpkgs' `addCheck`
shape to buy parity), so every functor-keyed reader correctly took it for the bare base. Making the producer honest, plus ONE
explicit reader of a declared base, measured zero regressions three times over and was cheaper.
A consumer-side guard places a permanent obligation on every reader, and copying an upstream shape
for parity can import the upstream's own accident.

**How to apply:**

- Before recommending an arm that changes N readers, ask whether the thing they read describes itself
  truthfully. If not, put the producer-side arm first.
- Price the producer arm's unmeasured premise with a scout rather than recommending around it.
- Prefer a construction that makes the defect impossible over a repair of a bad intermediate.
- Do not borrow a nearby rule by name: a rule about the threat model (caller mistakes) is not a rule
  about self-misdescription.

Related: \[[silent-fallbacks-delocalise-failures]\] \[[arms-that-should-not-be-offered]\]
