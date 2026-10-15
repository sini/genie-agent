---
name: gates-need-an-oracle
description: Before opening an adversarial review gate on a spec, design or plan, and when writing the oracle cells it will judge
type: practice
---

**Rule:** Before a gate, name what settles it. An executable oracle (a test, a differential)
supports review rounds. A person's judgement gets ONE reading by that person, not rounds. No
oracle means no gate. An oracle cell's RED and GREEN values are EVALUATED before the cell is
written, not derived from reading the source.

**Why:**

- Seven adversarial rounds on a plan co-designed with the owner grew it from 350 to 660 lines
  and deleted twelve of the owner's own rules. One of them was "the plan's job is to minimise
  the number of decisions that must be made". A drift audit found 30 of 103 rules surviving as
  written, and 52 agent-introduced, 29 of which constrained the owner. Prose always admits
  another reading, so "run until dry" never terminates on prose. Owner: "Acceptance criteria
  is owner signoff. I cannot assign a number to an unknown any easier than you can."
- **Reading gates verify sections; only construction composes them.** Twenty rounds validated
  a spec whose two sections could not both be implemented. One implementation contact found it
  in minutes.
- A round added two oracle cells whose red and green values were reasoned out and never run. A
  fresh reviewer found three stated values false and one control unable to discriminate. The
  dispatch had handed the author a derived red shape, and a derived expectation inherited from
  the dispatcher is still derived.
- **Same-pass check:** a builder emitted a plausible hash right beside its own "I won't guess"
  disclaimer. A check that runs in the same pass as the thing it checks is not a check.
- Mechanical tasks given executable oracle apparatus spent two gate rounds on defects in the
  INSTRUMENTS. Owner: "this is taking longer than it should for what should be a mechanical
  task." The tell is gate findings recurring in the apparatus, not the artefact.

**How to apply:**

- Owner-authored text is evidence, not reviewable material. A reviewer may flag it; only the
  owner removes it.
- Before an artefact reaches the owner, diff it against the last revision they approved and
  report the fraction of their text surviving. This is cheaper than any round, and it was the
  only instrument that caught the deletions.
- Start implementation early against a validated core, and treat implementer STOPs as gate
  findings.
- Put "evaluate each cell's red and green before writing it" in the DISPATCH, not in the
  reviewer.
- Split a large spec into a small frozen core (what gates attack) and a measurement ledger
  (verified by re-running commands, not by re-reading). Commit artefacts at every round
  boundary.
- Contact caps and reserved classes: \[[review-economy]\].

Related: \[[review-economy]\] \[[reviewer-findings-are-hypotheses]\] \[[decision-tiers]\]
