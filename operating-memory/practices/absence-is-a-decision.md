---
name: absence-is-a-decision
description: When a schema field, annotation or declaration may be missing and code must decide what its absence means
type: practice
---

**Rule:** What a missing declaration means is a design decision. Prefer making the field
REQUIRED and TOTAL over choosing a default. If a default is unavoidable, make it the
restrictive one and write down why beside it.

**Why:** a policy rule carried an optional annotation naming which node kinds it fires at, and
the code read "no annotation" as "fires everywhere". On the real corpus, a policy the schema
explicitly excluded fired 241 times, and a probe policy selected nowhere also fired 241
times. The old system fired both zero times. The correct reading ("an empty annotation drops
it at every node") was already written one file away. Definition had been confused with
selection: every policy defined anywhere became a policy applied everywhere.
A permissive default fails silently and everywhere, and the failure looks like the system
working. A restrictive default fails loudly the first time something is under-declared. The
omission is also invisible to review, because it lives in code that does not mention the
field.

**How to apply:**

- A required field aborts by name at the one funnel it must pass through, so no call site can
  forget it.
- **Ask WHO can produce the absence.** "In no includes list ⇒ selects nothing" was correct
  for user-written policies, and it deleted a machine-synthesised global from every node,
  because that mechanism was ambient by construction and no schema would ever list it.
  Declaration beats derivation: honour a declared value (an explicit `null` is a value) and
  derive only a genuinely undeclared one. A derivation validated on user inputs is unvalidated
  for synthesised ones.
- **Watch for the shadow pair:** an unconfined copy and a confined copy of the same thing
  means the question has been decided twice, differently.
- **The dangerous regression looks like the fix.** When a change exists to make X stop
  happening, every X stopping reads as success. Check WHICH instances stopped, by name, not
  how many.
- The same holds for claims about code: a predicate matching nothing may mean the construct
  is gone, or that the predicate never looked (\[[armed-controls]\]).

Related: \[[by-construction-over-repair]\] \[[refuse-honest-mistakes-by-name]\] \[[backlog-is-one-defect]\]
