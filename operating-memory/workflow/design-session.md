---
name: design-session
description: How to run an owner-present brainstorm for a new named thing (library, repo, user-facing surface, component) before any spec is written.
type: workflow
---

# Design session (N-class brainstorms)

**Rule:** A NEW NAMED THING is designed with the owner present, before any spec. Agents do not author
a design outside this flow. This session brainstorms, banks the approved design and dispatches
scouts; it does not spec, build or gate.

**Why:** A spec whose open question is "what is it, where does it live, what is it called" is a
design nobody approved. Settling it in passing makes a decision nobody made.

## Prep, before the owner sits down

Dispatch ONE scout over the session's items. Per item, it:

1. re-read the row's newest entry and every report it cites;
2. re-derive each premise at HEAD, tagged `[MEASURED <sha>]` / `[RELAYED]` / `[ASSUMED]`;
3. quote the standing rulings that constrain the design, so the brainstorm neither re-litigates nor
   contradicts them;
4. name prior art (a theory question is a dispatch, not a guess);
5. return a one-page brief: problem, constraints, what is measured, what is open, 2-3 approaches
   with trade-offs; one report file per item at a free path.
   The scout makes no tracker writes.

## The brainstorm

1. Context from the prep brief, in plain terms; the owner's own words first.
2. ONE clarifying question at a time; wait for the answer.
3. Two or three approaches, each lettered with its price; foreclosed ones marked; a recommendation
   and a counter-case. Before calling something a fork, name the clause you read and what it failed
   to answer.
4. Sections approved ONE BY ONE. Write a section only after approval; record the approval verbatim.
5. On a reframe, re-derive the approaches and say what changed. A missing fact: dispatch a scout and
   continue on another section.
6. Names: a new named thing is named by the owner; small names inside an approved construction are
   the orchestrator's.
7. The owner reviews the written design document before it is banked.

## The record

- Design doc at `specs/YYYY-MM-DD-<topic>-design.md`: approved sections verbatim, approach taken,
  rejected approaches with reasons, the counter-case, what remains open, unapproved sections marked.
- The item's row gets a banking block: approval verbatim, doc path and sha, the OWED next act (a spec
  dispatched by the build session), and its owner-blocking edge removed in the same act.
- An unfinished item keeps its edge and records which sections are approved.
- One tracker item per design session spans its fresh-context RESTARTS (a restart every few items, or
  when the budget gates fire). It closes only when the owner declares the session over.
- The queue's order changes only by appending a new dated ORDER block; the newest governs.
- New owner asks get a row the same day.

## Restart / close

Append a dated RESTART (or CLOSE) block: each item approved / partial / deferred, doc shas, rows
filed, scouts running, next items. Stop or bank every scout; message the build session with the specs
now owed; verify each of your commits reached origin after the build session's next push
(`git merge-base --is-ancestor <sha> origin/main`, with an unresolvable sha as control). Do not write
the handoff file.

Related: \[[owner-sitting]\] \[[orchestrator-operating-rules]\] \[[shared-checkout-peer-sessions]\]
