---
name: delegate-authoring
description: When you are the orchestrator of a multi-agent session and are tempted to write specs, plans or sweeps yourself
type: practice
values:
  writer-revivals: provisional
---

**Rule:** The orchestrator keeps JUDGEMENT and delegates execution AND review. Spec, plan and
document authoring goes to fresh-context agents; the orchestrator's turns go to adjudicating
forks, synthesising verdicts, owner-in-the-loop decisions and tracker reconciliation.

**Why:** the orchestrator is the scarce, long-lived context. Every plan or spec written inline
burns tokens needed to hold the whole arc. Workers are cheap and disposable, and their context
resets. The owner flagged drift twice: once to a generic unnamed agent, and once to nearly
cutting independent plan review "for just aliases", which was a quality slip.

**How to apply:**

- Keep a named-role pipeline: scout → planner → INDEPENDENT plan review → writer → two-stage
  review → gate. Plan review is not skippable, even for extra-small tasks.
- Name agents by role. Use the stronger model for non-mechanical work.
- Small tasks may be planned inline. For anything complex, dispatch the author, review its
  output, and keep only the decision, not the prose.
- A mechanical tier removes ceremony, not delegation. The tell: you are hand-writing the
  third `sed` of a sweep.
- An auditor does not fix what it audits. A reviewer gets the artefact and the rubric, not the
  author's framing. Repairs go to a separate build dispatch.
- One agent per writable tree. Read-only agents may run concurrently.
- Namespace scratch files by work-item id. Sibling agents share the session scratchpad, and
  one agent's generic `run.sh` overwrote another's mid-run, destroying 68 of 80 measured rows.
  Commit the runner, so a collision cannot reach the recoverable copy.
- A revived writer has a round budget (about 3 or 4 revivals). After that, retire it and give
  a fresh author the artefact, the newest verdict and the written lessons list. One 17-round
  author reached about 1M tokens.
- Ask workers for terse output: no filler or hedging, but full sentences.

Related: \[[writing-a-dispatch-brief]\] \[[decision-tiers]\] \[[agent-report-delivery]\]
