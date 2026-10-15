---
name: arms-that-should-not-be-offered
description: When an option in a design fork regresses behaviour the reference implementation supports, depends on changing an upstream you do not control, or hinges on an unmeasured fact.
type: practice
---

**Rule:** Do not offer as acceptable an arm that refuses what the reference system serves, or an arm
that needs the upstream to change. Treat the first as a smell to root-cause; mark the second
foreclosed. When arms hinge on an unmeasured fact, the right new arm is "measure first".

**Why:**

- Context: gen re-implements the nixpkgs module system (gen-merge and friends), with evaluation
  parity against nixpkgs as a core objective. A proposal priced "cells refused where the upstream serves" as an acceptable
  shortfall. Owner: "anywhere that's true has a significant smell; we need to step back and look at
  why, regardless of past rulings." A rarity exemption was proposed and rejected: a census proves
  presence, not absence, so "rare" cannot be established.
- An arm requiring a patch to the upstream library was recommended as "the only measured arm that
  meets both conditions". Owner: "impossible, we can't change it." Parity has to hold against releases
  already shipped, and upstream acceptance is outside your control.
- A parity question depended on WHERE a check was dropped (the upstream's own evaluation, or the
  re-implementation calling an upstream function). That was unmeasured. The owner took "measure first";
  a scout split the cells by class and the ruling followed the split.

**How to apply:**

- Before putting an arm whose price includes a regression against the reference: name the mechanism
  forcing it, look for the construction arm (thread the value, re-home it, fix the walk), and audit the
  ruling that forbids serving. Put the root-cause arm and a scout, not the shortfall. Challenge a past
  ruling if it is provably a design defect.
- Landing rules that came with this: a landing does not regress a working cell; a landing that only
  moves cells up the severity ladder (abort to refusal to value, silent to loud) may land; order work
  by severity, then positive evidence of presence.
- Upstream-change arms: list as foreclosed with the reason. Look for your side's form of the same
  mechanism. An upstream patch can still be useful as a MEASUREMENT of where the theory puts the door.
- Parity is not value-identity. Read the actual criterion's clauses, find the fact that decides which
  applies, and establish it (a spy that throws plus `--show-trace` usually settles it) before arms.
- Check whether an existing "refusal" ever enforced its check at all. In one case the check fired zero
  times.

Related: \[[before-asking-the-owner]\] \[[fix-the-producer-first]\]
