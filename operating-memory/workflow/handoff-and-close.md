---
name: handoff-and-close
description: The ordered close procedure for an orchestrator session and the voice rules for the handoff file the next session boots from.
type: workflow
scope: local
---

# Close procedure and handoff

The handoff file is the successor's memory. It is WHOLESALE-REPLACED at every close. It carries
STATE and OBLIGATIONS; the trail lives in git history and tracker bodies.

## Ordered close steps (each has a pass/fail reading)

```bash
# 1. IN-PROGRESS AUDIT: a live agent holds each in_progress row (name it in the commission)
#    or nothing does; flip the rest to their real status with the reason ON THE ITEM.
br list --status in_progress --limit 0          # read every row, not a count

# 2. EXPORT CURRENCY, then a PATH-SCOPED commit of the tracker
br sync --status                                # dirty count reads 0
git add .beads/ && git commit -m "beads: <what closed>" -- .beads/   # never -A

# 3. MEMORY: list rules that changed this session; retain each into the memory bank and read it
#    back from the durable side, not from the tool's response. Bank measured traps and owner
#    rulings, not an account of your own work.

# 4. THE HANDOFF: read the predecessor whole, then replace it. COMMISSION field first.
git show HEAD:<handoff-file>

# 4b. VOICE LITMUS (expected: hits only inside verbatim owner quotes)
grep -nE '\b(I|my|me|myself)\b' <handoff-file>

# 5. THE GATE (if you have one): refuse a SILENT drop
#    - a not-closed id in the predecessor that is absent from the successor
#    - a missing COMMISSION field; a sentinel line count != 1
#    - an in_progress row still open; a stale tracker export
#    A deliberate drop passes with a stated reason (e.g. an env var ACK="why").

# 6. PUSH-STATE SWEEP over every repo touched; anything past the branch header is not clean.
for repo in <every touched repo>; do git -C "$repo" status -sb; done

# 7. THE SUBTRACTION QUESTION, answered in the handoff: what this session removed (declined
#    offers, replaced checks, dissolved questions), and what it added that earned its place.
```

## The carry set = purpose

Carry an id only beside the REASON it is carried: owed to the owner, a named next dispatch, a live
chain. An id with no stated why is dropped (acknowledged, not silent); it stays in the tracker.

## Voice rules for the handoff

1. **No first person** outside verbatim owner quotes. Name artefacts and actions: "the claim in
   report X was wrong; corrected at <sha>", not "my correction was wrong".
2. **No self-assessment metrics.** No mistake counts, no "N self-corrections" headlines. A correction
   that produced a durable rule is recorded as THE RULE in its home, cited by id.
3. **Defects are facts about artefacts, with a fix state.** Re-derive the fix state at the closing
   HEAD, not when found. Measured: a handoff listed four live defects; three were already fixed by
   the same session's later commit, and the successor built a brief on the stale three. Prefer the
   fixing commit over a carrying tracker id; check for one first.
4. **Vigilance is a procedure, not a mood.** Do not tell the successor to distrust itself. Give the
   command, the predicate, and where it lives.
5. **Emphasis marks load-bearing content**, not shame.
6. **The commission field is forward-looking imperatives with ids only.**
7. **Re-carry content, not register.** Extract a predecessor's obligations; drop its voice.

Why the voice rules exist: measured, sessions that booted from a confessional handoff ("my
self-correction was ALSO WRONG", "NINE self-corrections") echoed it as live self-blame ("I am the
largest risk here") and worked worse.

Litmus per sentence: it states a fact about the world or an artefact, or an obligation with an id or
path. Otherwise it goes.

## Do not hand off early

A handoff drafted before the close-out gate is rewritten at close; bank obligations into tracker
bodies as you go instead. Do not close with an agent still running: commit its results first.

Related: \[[do-not-wind-down-early]\] \[[resume-prompt-template]\] \[[orchestrator-operating-rules]\]
