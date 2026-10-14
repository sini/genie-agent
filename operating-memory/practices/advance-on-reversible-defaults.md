---
name: advance-on-reversible-defaults
description: When a unit waits on an owner decision and the fleet would otherwise idle; when to decide yourself and how to record it
type: practice
---

**Rule:** An owner reading does not stop work. Take the prepared recommendation as a safe,
reversible default, build on it, and record it on the row as "defaulted, reversible, owner to
confirm". Resolve questions answerable from theory or standing law yourself, and log the
decision for post-hoc review.

**Why:** the fleet sat idle on "everything waits on the owner", and the owner said: "for
decisions banking on me, you can still advance and take a safe reversible default for
confirmation later." Earlier, owner: "drive execution autonomously", meaning do not stop at
gates you can resolve, but keep each call auditable.

**How to apply:**

- "Safe" means reversible without data loss and not cheaply foreclosing the other arms. Prefer
  arms that refuse loudly over arms that admit silently, and arms that reopen nothing already
  landed. If no recommendation exists yet, prepare one first.
- Split questions two ways:
  - **genuine owner design input** (product, priority or scope trade-offs, or API commitments
    with no theory-determined answer): bank it, and keep working on independent work;
  - **resolvable from sources or principles**: make the call and append it to a decision log
    with the question, the options, the call, the source basis and a `REVIEW?` flag.
- Autonomy means not blocking on gates. It does not mean skipping review: the pipeline still
  runs (scout, plan, independent plan review, build, review, gate).
- Reject half-measures shipped "to move fast"; ship the right shape the first time.
- **Limit: this does NOT extend to designs.** A design default was banked for a spec while the
  owner was away; the build session caught it and held the spec, because the rule that a new
  thing's spec waits for an approved design is more specific and outranks this one. The same
  goes for defaults that refine an owner ruling. Defaults are for readings with clear
  recommendations, routing, and choices inside an approved design.
- A design that has passed its adversarial gate rounds, with conditions applied, counts as
  owner-approved where the owner has said so. Bank it with that rule quoted. Owner-only items
  (law readings, new named things) are still asked.

Related: \[[before-asking-the-owner]\] \[[decision-tiers]\] \[[keep-the-fleet-full]\]
