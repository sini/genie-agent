---
name: dispatch-form
description: The template an orchestrator fills in before sending any task to a subagent, plus what every brief must carry and the tells that a brief is wrong.
type: workflow
---

# Dispatch form

Agents carry the STANDING half (instrument facts, measurement law, reporting and hand-off protocol;
see `roles/`). The brief carries the TASK half, and links rather than restates. Before sending,
recall your memory bank on the dispatch's SUBJECT (the tool, library or kind of work), not on the
task id: the dispatch is the last point where prevention is cheap.

## The form

```
You are <task-id>-<role>.            # name every agent; the roster shows it
Agent: scout | spec | gate | build

CARRIER:  <tracker id>               # findings return here
CLAIM:    mark the item in_progress BEFORE sending; release at return.
          An unclaimed item with an agent on it is a tracker that lies.
TIER:     M | D | R
TARGET:   the component this lands, and the demo/corpus example (gen-demo for gen) that exercises it (same landing)
DESIGN:   pointer to the owner-approved design, or "existing component".
          A brief naming a NEW component without one is not dispatchable.
SIZING:   lands in one dispatch with its integration arm green, or split before sending

PREMISE - tag every line; conclusions only:
  [MEASURED <sha>]   <claim> -- <the command, so the agent can re-run it>
  [RELAYED <source>] <claim> -- who said it; you have not checked
  [ASSUMED]          <claim> -- belief without evidence

SCOPE:
  IN:     exactly what to touch
  OUT:    what is excluded, and why it is not an oversight
  CLASS:  instance | discharge the class (and how to enumerate members)

DELIVERABLE: reports/<task-id>-<subject>-<role>-v0.md   (check the path is FREE first)
             WRITE | COMMIT | COMMIT+PUSH -- say which, PER REPO
WORKTREE:    <path> at <explicit sha>  -- one writer per worktree
             or SHARED CHECKOUT at <sha>; HEAD may move; pin every read to the sha
EXIT:        the gating oracle (component landed, consumer builds, example green) and who confirms it
```

## What every brief carries

1. **Tagged premises.** A tracker-body citation is `[RELAYED]`, never `[MEASURED]`: the command
   proves "the artefact SAYS this", not "this is TRUE". Measured across four sampled sets of past
   runs: the brief carried a false load-bearing claim in 4/8, 4/8, 5/8 and 8/8 of runs.
2. **Quote the row, never the generalisation.** The likeliest false premise is YOUR summary of an
   agent's report. Measured: in one session, four of four false premises were the orchestrator
   compressing a report, and the counter-evidence sat in the report's own table. Distrust on sight:
   universals ("uniformly"), ratios over a population, "the only", borrowed warrant ("already
   verified"). Paste the measured cell and its control instead.
3. **An oracle's RED and GREEN**, evaluated before the cell is written and stated in the brief.
4. **The class, said out loud.** Authors default to the single instance. The trigger for "discharge
   the class" is the SECOND member found.
5. **Theory, mechanism and argument asked apart.** One blended "is this right?" returns one blended
   answer, and the three fail independently.
6. **A file path for every deliverable.** Measured: six of eight agents finished correct work and went
   idle silently; every deliverable named by path was recovered from the tree; the one named only as
   "report X" was lost.
7. **Conformance with the project's own patterns**, on every landing, M-tier included.
8. **Every test cell that PINS a surface the edit touches**, not just the surface. Find them by
   seeding: plant the change and watch which cells go red.
9. **Commit + push to a main** carries: "after pushing, fast-forward the shared local checkout
   (`git -C <repo> merge --ff-only origin/main`, only if clean and on main; else report, never stash)".

## Worktree and path hazards

- The scratchpad is shared by all agents of a session. Namespace every file
  `<scratchpad>/<task-id>-<name>`; give each scratch clone its own directory. Measured: two agents
  wrote the same `sweep2.sh`; another reset a peer's clone mid-run.
- `git clone --local` across filesystems fails (EXDEV); use `--local --no-hardlinks`.
- A `--local` clone's `origin` is the local checkout. Set `origin` to the real remote URL before
  pushing, or the branch lands on the local disk (measured twice).
- Read a dependency's revision from the lock file by node path, never from a clone's HEAD. Measured
  over 22 repos: 6 differed outright.
- Check report paths are free: `ls reports/ | grep <id>`. Measured: a gate told to write
  `<id>-gate-v0.md` overwrote a 580-line committed report. Name the SUBJECT, not just the role.

## Tells that a brief is wrong before you send it

- It restates instrument facts the agent already carries (they get restated wrong).
- It says "carefully" or "make sure". That is not a specification.
- It asks for a fix and a report in one breath. Split: scout, then build.
- It cites a "VERIFIED" from a status block. Give the sha; let the agent re-derive.
- You cannot state EXIT. You do not yet know what you are asking for.
- Before any act on a row, ask what would make the act WRONG, and read the row's newest entry.
- A count or list of prior work taken from a tracker BODY. Derive it from a listing in the same act.
- A bare identifier that several documents define differently. Resolve it and name the source.

Related: \[[roles-common-protocol]\] \[[orchestrator-operating-rules]\] \[[external-agent-management]\]
