---
name: relay-through-the-hub
description: When rulings, landings or corrections must reach agents that are already running; sequencing races between independently correct acts
type: practice
---

**Rule:** The orchestrator is the relay hub. Push every ruling and every landing to each live
agent it affects, in the same turn you record it, and never let two subagents coordinate a
load-bearing fact directly.

**Why:**

- Agent-to-agent messages returned `success` and delivered nothing, twice, with message ids.
  A missing relay then reads as a refutation of whoever was named.
- Agents do not poll the tracker. A ruling recorded there never reaches an agent already
  running.
- A merge changes the subject under a measuring agent. Fast-forwarding a repository nine
  commits while an author measured it at the old revision cost that author a re-verification
  round; relaying to one sibling but not another cost a correction round.
- Messages do not interrupt tool use. A busy agent finishes its turn, reports, idles, and only
  then reads the queue, so "add this to the same landing" sent mid-flight lands as a separate
  unit. Queued messages execute in the order sent.
- **Crossing races:** every act was individually correct and the ordering was wrong. A gate
  approved a tree that a pending supplement then changed; a fix round ran against a deleted
  structure. No instrument that inspects an artefact can find this, because the premise lives
  in a message.

**How to apply:**

- Before merging into a repository any live agent measures, message every live agent
  (enumerated from the roster, not from memory) the new revision and the changed paths.
- Ask the recipient to echo a relayed fact back, then grep the ARTEFACT for it. A report
  organised around the brief has no slot for a late addition, so its absence is invisible.
- Whatever must be in a landing goes in the opening dispatch. After that, it is two units.
  Send a correction BEFORE a larger instruction, or fold it into it.
- Pin or gate only after confirming no supplement is pending to any writer of the artefact.
- Gate anchoring and in-flight movement: \[[dont-review-a-moving-artefact]\].
- An executor that sees a stale premise STOPS AND ASKS. Seeing it is easy; stopping is the
  hard part.

Related: \[[agent-report-delivery]\] \[[writing-a-dispatch-brief]\] \[[one-writer-per-checkout]\]
