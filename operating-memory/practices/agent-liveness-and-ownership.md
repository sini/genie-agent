---
name: agent-liveness-and-ownership
description: When an agent says "waiting", goes idle, is inherited from a handover, or its repo is about to be reassigned; and before closing a session with agents live.
type: practice
---

**Rule:** An agent's liveness is not observable from the files it writes. Only the spawning session's
agent list (`ListAgents`) knows. "Waiting" from an agent is a claim to check, idle is not dead, and
the orchestrator owns every agent it dispatched until each returns.

**Why:**

- `git status` clean reads "finished" while an agent is between commits. File mtimes go quiet by
  construction after a push, because a commit does not touch working files. A peer declared a tree
  "safe to write" and retracted it an hour later.
- A builder said "waiting on the background run", the run died without notification, and the agent
  sat 4 hours with half its work uncommitted in a worktree.
- An agent reported STOP and went idle; its repo was re-dispatched. A message queued earlier woke the
  old agent, which edited 7 files while the new owner was working. The new owner reported a second
  writer. Idle agents still have an inbox.
- A session wrote its handoff at about 87% context with five gates and a build still running. Owner:
  "you own the agents you dispatched. See these through."

**How to apply:**

- On any "waiting" idle notice, check in the same turn: is there a live process (`ps`), and what is
  the newest mtime in the agent's scratch dir? No process and a stale mtime means stalled. Wake it
  with the completion line from its own output file.
- Inherited handover naming a live agent: ask the parent session for its agent list. Treat the tree as
  hot until told otherwise. If the parent is gone, use `git diff` for shape, save it as an unverified
  starting point, and re-drive every test.
- Before reassigning a repo: stop the old agent first (`TaskStop`), then dispatch the successor. If a
  collision happens anyway: stop the stray writer, confirm the tree is stable, save its partial diff,
  and give the successor sole ownership with an adopt-or-reset choice.
- An idle report is not a finished report. Before killing an agent's runs or re-dispatching its
  task, read its transcript age (the session's `subagents/agent-<id>.jsonl`; written minutes ago
  means alive) and check whether a message you sent it is still unanswered. One agent's idle summary
  still listed as open a question the orchestrator had already answered: the answer was queued, not
  read. The orchestrator dispatched two replacements and killed its runs; the agent then woke on the
  queued answer and built the same arm as one of the replacements. When splitting an agent's work,
  send it the split before dispatching anyone else.
- Before any `TaskStop`, do three reads: the transcript tail (about the last dozen entries: what is it
  doing now, and has a stale queued message just woken it?), its live processes
  (`ps -eo pid,etimes,args`, filtered on its scratch dir), and the newest file ages in its scratch dir.
  `TaskStop` does not stop the agent's background shell jobs. A stopped agent's paired benchmark and
  dependents run held a shared lock for hours with nobody left to read them, and were killed by PID
  with the measurements lost. Let live jobs that someone will read finish; otherwise stop them by PID,
  child first, in the same act, and record which measurements are lost.
- `TaskStop` is not final: any later message to the stopped name resumes it, whoever sends it. When a
  spec's gate passes and a build takes over the spec file, stop the spec author in the same act.
  Send "main moved, rebase" broadcasts only to agents whose unit is still theirs: twice, an author
  whose spec a build already owned woke on a broadcast and re-edited it. Every brief that inherits
  another agent's files says "never message the prior author; route through the orchestrator".
- The opposite failure: a subagent idling on its own `run_in_background` task is often not woken
  when the task exits. Two agents sat idle 2 and 4.5 hours on finished results, one of them holding an
  unread CI failure. When a waiting agent's transcript has been silent for about 30 minutes, read its
  task output files; if they have exited, resume it with a message quoting the results.
- Do not close a session while dispatched agents are live. Keep committing their results as they land.
  Write the handoff when the live count is zero or a hard context limit forces it, and re-commit as
  late results arrive.

Related: \[[kill-only-captured-pids]\] \[[resume-failed-agents]\] \[[peer-sessions]\]
