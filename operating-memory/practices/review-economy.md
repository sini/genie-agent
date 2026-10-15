---
name: review-economy
description: When deciding how much review, control or ceremony a change needs, whether another gate round is owed, how gate reports travel, and what to do when rounds stop converging
type: practice
---

**Rule:** Put controls only where failure is silent. One gate contact by default; a second needs a
reserved-class ground; a third means the spec or design is defective: it goes back to a fresh design
agent, or to the owner, or is dropped. Findings with a gate-specified remedy fold into the landing
commit only when the remedy is mechanical (a rename, text, or a value the gate computed and the
oracle re-checks); a remedy that changes logic re-runs the gating oracle and gets one fresh
reviewer. Only CONSTRUCTION findings re-enter the full gate. Every process rule states its cost and the
condition under which it retires, and a relaxation is measured before it becomes law.

**Why:**

- Mechanism yield fell 27.6% → 15.2% → 8.3% → 0 across successive rounds. In one day, three policy
  round-trips, three zero-yield second clean rounds and a four-pass amendment chain bought nothing the
  cheaper forms did not. A month ran a docs-to-code ratio near 29:1; a blocker burndown closed 118
  items to net +6 open; one eight-day window doubled report files while the backlog stayed flat.
- Banked traps recurred after banking; every recurrence was caught by a run-time control, never by a
  reader of the trap log.
- Patching review findings one at a time introduced new defects each round. A fresh design agent
  reworking the whole document from every report produced a design that passed.
- Two gate crossings came from orchestrator compression: a superseded revision got reviewed, and
  unrelayed sections went uncovered. Two retyped spans dropped backticks and matched nothing.
- A churn measurement was dispatched for a fork the owner had already priced: "why are we wasting
  tokens on it? kill it." An impact figure for a person-judged fork is a manufactured metric.
- A release-process relaxation was written straight into project instructions. Owner: "I would like it
  measured before adopted as law. If it turns the 1h18m run into ~10m, it's a clear win. If not, it's
  a correctness cost for a minor velocity bump."

**How to apply:**

- Silent failures (absence claims, greps, counters, a cost blowup returning the right answer) need
  controls. Loud failures (suite red, build break, named refusal, even an uncatchable abort) need none.
  Classify by whether anything REPORTS the failure, not by how bad it is.
- **Reserved classes** that may run past one contact: substrate identity or ordering semantics,
  refutations of standing results, novel constructions entering the substrate. Otherwise exit after one
  construction-clean contact; a second round only as a bounded delta check.
- **Exit by byte-identity transfer:** prove the mechanism surface unchanged (a digest or tree diff,
  measured in the verdict), transfer the earlier instruments, verify only the delta.
- **Third contact:** a fresh design agent gets the document, every report and owner rulings as
  premises, reworks the whole, and a fresh reviewer takes contact 1. Do not override the cap for "one
  final review".
- The finding gate drafts owner-facing amendment text in its verdict; one fresh reviewer checks it. The
  drafter never reviews its own draft.
- **Reports are FILES** at a versioned path (`reports/<item>-<role>-v0.md`, bumped per round). The
  message carries verdict, findings table, anchors and path; the verdict line also lands in the tracker
  body. Artefacts travel as files, never relay prose; spans are machine-extracted, never retyped;
  appliers match content, not coordinates.
- A new instrument proves its armed control once, at introduction, in-tree. Recurring tool faults
  become tooling fixes, not more warnings.
- Counts downstream of a batch's own edits are stale by construction: re-derive at the landing rev.
  Stale counts during a retirement wave are churn; fix one only when touching the surface or when a
  decision rests on it. Formatting churn is not a risk class.
- For reference-grade libraries, deletion needs a domain argument; a usage count is not a ground.
- Process changes run as a trial with an explicit acceptance number, recorded where tracked.
- The teeth do not lighten: construction findings block unconditionally; gates use fresh contexts and
  armed controls.

Related: \[[gates-need-an-oracle]\] \[[filing-caps]\] \[[relay-through-the-hub]\] \[[spec-and-plan-before-code]\] \[[armed-controls]\]
