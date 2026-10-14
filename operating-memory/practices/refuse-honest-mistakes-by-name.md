---
name: refuse-honest-mistakes-by-name
description: When designing or reviewing guards, identity checks, or library constructs that apply a caller-supplied function
type: practice
---

**Rule:** Judge a guard by what it does on an honest caller's MISTAKE: a named, catchable
refusal beats a silent wrong answer. For every caller-supplied function, the spec enumerates
its failure inputs and gives each one either a refusing door or a falsifier test.

**Why:**

- **Threat model.** Reviews kept arguing from forgery ("a deliberate forger could bypass
  this"). The owner: "we're not so much concerned with forgery as we are about error — this is
  not a cryptographic system." Forgery arguments can reject a design that fixes real errors.
  A forgery path matters only when it is also reachable by mistake (a record passed where a
  reference belongs, a stale `//` copy, a misspelt value).
- **Totality, found one contact at a time.** A library construct taking a caller predicate
  went through three landing reviews. Each found the NEXT member of one class (an uncatchable
  abort on a formal, then a non-boolean return passing through `builtins.all`, then a pattern
  formal getting past an `isFunction` door), and each repair claimed the class closed.

**How to apply:** for every caller-supplied function formal, the spec's totality section
covers four inputs:

1. a non-function: refuse with `builtins.isFunction`;
2. a function returning the wrong type: check the APPLIED result before a typing builtin
   consumes it;
3. a curried under-application: the same result check catches the leftover lambda;
4. a pattern formal (`{ x }: …`): `isFunction` is true and the call aborts inside
   application, uncatchably, so it is undecidable at the door. Land it as a falsifier cell
   that expects that exact error, never as a claim that "the bound is closed".
   At a landing gate for such a construct, run these four as seeds before anything else. In
   tests, "forged" fixtures remain useful stand-ins for mistakes, but rank the design arms by
   their error behaviour.

Related: \[[absence-is-a-decision]\] \[[by-construction-over-repair]\]
