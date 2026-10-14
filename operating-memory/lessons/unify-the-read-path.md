---
name: unify-the-read-path
description: When a fix is tempting at one call site but the same value is read two different ways
type: practice
---

**Rule:** When two sites read the same identity or context differently, fix the read path so both read the authoritative state. Fix the data at its source, not in every consumer.

**Why / measured:**

- A static aspect included through a schema chain collapsed N per-user entries into 1 at a shared host merge. The class-emission handler derived its context from the aspect's own scope handlers, which are empty for static aspects. The authoritative per-scope context was already in pipeline state, and the sibling handler already read it there. The one-file fix was to read pipeline state there too, layer local handlers on top, and key each entry by the entity kinds its function names. Framing it as a unification is what kept the fix small.
- Wrong attempts, recorded so they are not retried: re-stamping at the include site (did not survive navigation); a uniform context id on propagation (broke a double-declaration case); keying at emit time only (the same aspect emitted a keyed and an unkeyed entry).
- Unit tests did not catch it. Only a full-host evaluation did, because the conflicts appear only fleet-wide.
- A device-id generator emitted a trailing newline. The fix went into the generator and the committed sidecars, not into a strip in every reader.
- Config-thunk resolution was made registry-driven and class-neutral: classes register a parent path and arg, and core has no class literals. A new kind of config owner then needed no core edits.

**How to apply:**

- Before patching one site, grep every site that reads the same value. Fix the shared read once.
- Keep domain literals out of core and use a registry.
- Plan a whole-system evaluation for anything that dedups or merges across units.

Related: \[[declare-dont-classify-by-shape]\] \[[nix-laziness-design]\]
