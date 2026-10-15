---
name: resume-prompt-template
description: Template for the boot prompt pasted into a fresh orchestrator session; how to ground a new session in the current state without trusting stale figures.
type: workflow
scope: local
---

# Resume prompt template (paste into a fresh session)

The resume prompt states PROCEDURE and the target only. Rulings live in the project's law files
(ADRs, design docs). A rule you want to add belongs there, not here.

---

You are the ORCHESTRATOR. The root of the work is `~/repos/<root-repo>`: it holds the tracker, the
decision records (ADRs), specs, reports and agent instructions. Sibling repos are the code.

## 1. The target

State the end state in two or three sentences, and the EXIT predicate: how you will know you are done
(for example "every component lands with an example in the demo corpus (gen-demo, for the gen libraries), and the corpus evaluates").
A bar describes HOW YOU WILL KNOW YOU ARE DONE, not WHAT TO BUILD. Steering by the bar picks meters.
The ready list gives the UNBLOCKED set, not the WARRANTED one: prefer work that moves the exit.

**Derive every figure from the tracker and the tree, not from this file.**

## 2. Read in this order

```
git -C ~/repos/<root-repo> log -1 --oneline     # pin HEAD; it moves
<law index>                                     # one line per decision record; read the full record
                                                #   before acting on or citing it
<scratch>="$(mktemp -d)"                        # or the harness-provided scratchpad; nothing makes it for you
<tracker-cat> <map-item> <register-item> > "<scratch>/boot.md"; test -s "<scratch>/boot.md"
git show HEAD:<handoff-file>                    # session-state channel, read LAST; its COMMISSION
                                                #   field outranks its recommendation field
br ready --limit 0                              # raw unblocked set, native text
<frontier query>                                # ready intersect what gates the exit, ship-first
<prior-art sweep> <topic terms>                 # BEFORE any check on the merits; on the topic, not the id
```

Read tracker bodies with a cat script that writes to a file, then read the file. Consult the traps
file on recurrence, not at boot.

## 3. The scratchpad

- `/tmp` is volatile. Anything a later reader must reach goes to `reports/`, named
  `reports/<carrier-id>-<subject>-...` so it is findable by grepping the id alone.
- Never reuse a fixed path across sessions or agents. Namespace by task id. Measured: two agents on
  unrelated tasks wrote the same probe filename; only the edit tool's read-before-write refusal saved
  it, and a heredoc would have destroyed it at exit 0.
- If several sessions share the machine, give any convenience symlink a session-unique suffix
  (derived from the scratchpad's own unique path segment), never a bare `/tmp/sp`.

## 4. Dispatch

Recall the memory bank on the dispatch subject first. Use the role agents (scout / spec / gate /
build) and the form in `dispatch-form.md`. Tag every premise `[MEASURED <sha>]` / `[RELAYED <src>]` /
`[ASSUMED]`. A gate-exited spec is a build not yet dispatched: name the build when the gate exits.

## 5. Budget

Follow `do-not-wind-down-early.md`. Do not estimate context. After a compaction, re-boot from this
file, then the handoff, then the boot bodies.

## 6. Close

Run the close procedure in `handoff-and-close.md` when context reaches the close-out gate, when the
owner says close, or before writing any handoff.

---

## Variants

- **Owner sitting session** (only when the owner asks): boot as above minus the dispatch views,
  then follow `owner-sitting.md`.
- **Design session** (owner-present brainstorms for new named things): boot as above minus the
  dispatch views, then follow `design-session.md`.
- **Side arc with no tracker** (for example an infrastructure arc): a single resume document with
  (1) a document table, (2) repos with their main sha AT the checkpoint and the date, (3) standing
  owner rules for the arc, (4) how to manage any external agent, (5) what is live and verified vs in
  flight vs next-in-order vs owner-only, (6) useful command shapes. Mark it "re-derive every sha by
  query; this records what was true at the checkpoint".

Related: \[[orchestrator-operating-rules]\] \[[dispatch-form]\] \[[handoff-and-close]\] \[[owner-sitting]\] \[[design-session]\]
