---
name: decision-tiers
description: When filing or picking up a change, to decide how much ceremony it gets (spec, gate, owner reading, design session)
type: practice
scope: local
---

**Rule:** Classify every change when it is filed, and write the class and a one-line reason in
the tracker body.

- **M, mechanical:** the outcome is fully determined by an existing ruling or spec, and a
  failure would be LOUD. The tracker body IS the spec (problem, mechanism, oracle). Execute it
  directly, with its own test and no gate round.
- **D, design:** creates or changes a construct, representation or public surface. Needs a
  lean spec, an adversarial gate, and an owner fork where one exists.
- **R, ruling-only:** the owner is the oracle. One reading, with no manufactured measurement.
- **N, new named thing** (a library, repository, roster member, user-facing surface or
  framework component): starts with a brainstorming session WITH the owner. A spec is
  dispatched only against the design that session approved.
  A change whose tier is unclear is D.

**Why:** Owner: "you're treating all decisions as equal… the overhead of ceremony has become a
risk unto itself." The N class came from two misses on one day. A framework spec was
dispatched within an hour of a ruling that meant "enter the design phase now", and the owner
had to stop it ("jumps the gun"). A tooling unit was re-homed three times after dispatch, each
time on a clarification the owner could have given in one sitting. Mechanism: no tier existed
for a new thing, so it fell into D, whose route is "dispatch a spec agent", and spec agents
read artefacts, not the owner. "An idle fleet is a dispatch trigger" also beat "ask early".

**How to apply:**

- The tell that the brainstorm was skipped: a spec whose open question is what the thing IS,
  where it LIVES, or what it is CALLED. Stop and hold the build.
- Brainstorm form: context first, one clarifying question at a time, two or three approaches
  with trade-offs, sections approved one by one.
- A forcing function licenses ENTERING a design phase, not skipping it. "Properly
  architected" means the document order: requirements, assessment, architecture, diagrams,
  then specs, then plans.
- The opposite miscall: before routing a fix as N because it needs "a new declared surface", check
  whether the fact can be DERIVED from the constructors that already exist. A row was routed N for a
  declaration that a type does not rewrite its definitions. Owner: "Does it really require a design
  session?" It did not: the fact was derivable constructor-side, so the fix was D, and only a
  declaration for custom merges would have been N. A check that varies at runtime is not proof that
  a fact is underivable. Derive first; the brainstorm is the last resort, not the default.
- An M task that hits an undecided design fork mid-execution STOPS and promotes itself.
- A design agent revising an owner-approved design does not reword an approved sentence. One
  agent turned "closures never live in X" into "no closure is applied in X", which quietly
  revived an arm the owner had rejected. The dispatch says approved text is fixed, and asks for
  a sentence-level diff against the approval revision.
- The M tier removes the spec and the gate, not delegation (\[[delegate-authoring]\]).

Related: \[[before-asking-the-owner]\] \[[gates-need-an-oracle]\] \[[advance-on-reversible-defaults]\]
