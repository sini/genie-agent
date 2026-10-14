---
name: kill-only-captured-pids
description: When starting, stopping or waiting on a long-running/background process, writing a wait loop, or briefing an agent that may run long jobs
type: practice
---

**Rule:** Never use `pkill`, `pkill -f`, `killall`, or `kill` on `pgrep -f` output. Stop only PIDs you
captured with `$!` at launch. Wait on a `$!` PID or on a marker file the producer itself writes, always
with a timeout; never loop on `pgrep -f` from the waiting shell. Never stack watchers on a task that
already notifies. Subagents poll their own background runs; they do not idle waiting for a notice.

**Why:**

- An agent stopped its probe lanes with `pkill -f '<its-probe-dir>/run.sh'`, then looped
  `kill $ppid $pid` over `pgrep -f '…(run|lanes).sh'`. The pattern matched the shell running that very
  command line, so the loop killed that shell's PARENT: the orchestrator session. Every live agent had
  to be resumed by raw id. Two other agents disclosed `pkill -f` self-matches the same day. "Never kill
  a process you did not start" was already in the briefs: `-f` matches the full command line, and the
  command line that names the pattern contains it.
- An audit of one session found 13 orphaned waiter shells, 6 minutes to 22 hours old: two
  `until ! pgrep -f <script>` loops matching their own command line, never able to exit; two waiting
  for a marker a finished job never wrote; two on a path from a long-gone agent; seven copies of one
  finished agent's wait re-spawned per turn. The orchestrator's own `until [ $(ps -eo args | grep -c '<dir>') -le 1 ]` never exited for the same reason.
- An orchestrator stacked 13 Monitor tasks on one CI run. A `run_in_background` command already
  re-invokes you on exit; each Monitor expired after 5 minutes and was re-armed, piling up.
- Subagents do not reliably receive completion notices for their own background shells. Agents idled
  "waiting" 48 minutes and nearly 4 hours after their runs had finished.

**How to apply:**

- Launch `cmd & pid=$!`; stop `kill "$pid"`; wait `wait "$pid"`, or
  `timeout 3600 zsh -c "while kill -0 $pid 2>/dev/null; do sleep 10; done"`.
- Marker: `timeout 3600 zsh -c 'until [ -e out/ALL-DONE ]; do sleep 10; done'`, where the job writes
  `ALL-DONE` as its last act.
- Orchestrator: use `run_in_background` and wait for its own notice. Arm at most one Monitor, only for
  a condition no task signals.
- Every dispatch prompt carries, verbatim: "never use pkill/killall or kill pgrep -f output; run long
  jobs in the foreground (bounded timeout) or poll your own background run on its output marker; never
  wait for a notification."
- Auditing waiters: read each waiter's predicate against its target before killing, and kill by PID.
- Treat a pattern-kill in any agent report as a near miss to record.
- After killing an agent, check `git status --short` and `git diff` before dispatching a replacement
  (\[[read-shared-trees-at-committed-objects]\]). After an orchestrator dies, resume agents by id and tell
  them the new delivery target (\[[resume-failed-agents]\]).

Related: \[[agent-liveness-and-ownership]\] \[[agent-report-delivery]\] \[[writing-a-dispatch-brief]\]
