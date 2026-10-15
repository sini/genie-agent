---
name: owner-sitting
description: How to run a batched owner-decision session (a "sitting") beside a running build session; how to put questions, bank rulings, and wire blocked rows.
type: workflow
scope: local
values:
  open-sitting-items: owner-set 2026-09-30
  agents-during-sitting: provisional
---

# The owner sitting

A sitting is a session, opened only when the owner asks, that puts owner READINGS, banks RULINGS
and dispatches SCOUTS. It never builds, specs, gates, pushes, stashes, or writes the handoff. A
separate BUILD session runs beside it in the same checkout and owns all of that.

## One tracker item per sitting

- Exactly one open item labelled `sitting` exists at all times. It records what that sitting ruled
  and closes with it. 0 or 2+ open at boot: STOP and ask the owner; do not pick one.
- The agenda is the set of rows wired `blocks` to it (rows whose only remaining work is the owner's).

## Boot

Run the normal boot read order, minus the dispatch views. Then read the sitting item, its blocking
dependents, and any derived agenda script. Find the build session and send it one message: the
sitting is open and owns each row it rules while it runs.

## Agenda order

1. the owner-agreed priority order (found by its heading, not by position);
2. the handoff commission's priority list;
3. the rest.
   Rows carried from an earlier sitting are presumed STALE: dispatch ONE prep scout over all of them to
   re-derive each premise at current code and return OWED / SPENT / DISSOLVED / CHANGED. Put only OWED.
   Once the agenda is done, new forks go to the NEXT sitting (banked with their arms, not put live).

## Putting a question (every question, confirmations included)

1. **Background** in plain terms: the mechanism, measured figures tagged with revision.
2. **The question**, one sentence.
3. **Every arm**, lettered, each with its price. Foreclosed arms marked with the reason.
4. **Recommendation** by letter with its ground, and the **counter-case** at full strength.

- One item at a time. Read the spec or row before presenting; a relay line is a pointer, not a premise.
- On "what are (a)/(b) again" or a reframe: answer from the primary source; a reframe usually
  changes the arm set.
- Correct your own errors in the same turn you find them.
- When the owner misremembers a ruling, quote the banked ruling and offer readings; do not rule on
  the recollection.
- End every turn on the pending question. Relay peer notifications in one verified line between
  questions, not inside one.
- STOP MEANS STOP: an owner interruption halts all action, including recording.

## Banking a ruling (one act, every time)

1. Write the block to a file (edit tool, or a QUOTED heredoc `<<'EOF'`; an unquoted one executes
   backticks and has eaten words). Append it to the row; no bulk rewrites.
2. The block carries: owner's words VERBATIM; the ruled arm restated as a construction; rejected arms
   with reasons; the counter-case; the OWED agent work; where the law text lands. If a terse reply
   ("agree", "a") is read as covering a recommendation, say so: "read as ..., reversible".
3. Edges: remove the `blocks` edge to the sitting if the row now has agent work; keep it if only an
   owner act remains.
4. Law text is queued for a batched law landing; the sitting does not land law itself.
5. Commit path-scoped; message the build session with the rulings and rows.

## Scouts (the only dispatch a sitting makes)

At most 2-3 at once. Brief: quote the owner verbatim, tag premises, name a free report path,
memory-cap heavy commands, positive control on every absence, NO tracker writes and do not claim a
row (a claimed row trips the build session's close gate).

## Close

1. Append a CLOSE block: what was ruled (ids), what was filed, which rows are intentionally deferred
   and why each is owner-bound, which scouts still run.
2. Read the blocking dependents row by row. Check that ruled rows are already unwired. Every still-wired row
   (deferred, or never reached) is re-linked.
3. In ONE act: create the next sitting item; move each still-wired edge to it; check the old item has
   0 blocking dependents; close the old item only if so. (Closing with a dependent left releases
   that row into the ready list: the lie wiring exists to prevent.)
4. Stop or bank every scout. Message the build session. Update memory with owner corrections.

Related: \[[orchestrator-operating-rules]\] \[[shared-checkout-peer-sessions]\] \[[design-session]\]
