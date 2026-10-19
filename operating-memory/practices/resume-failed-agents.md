---
name: resume-failed-agents
description: When a subagent dies (overload, timeout, rate limit, crash), finishes with context to spare, or the orchestrator itself was restarted.
type: practice
---

**Rule:** Resume the existing agent by message (`SendMessage` to its name, or to its raw id after an
orchestrator restart) instead of dispatching a fresh one. A fresh dispatch needs a reason stated out
loud.

**Why:**

- A resume keeps the agent's transcript: the long brief it read, the reports it opened, hypotheses it
  formed. Two scouts died on a server-side `529 Overloaded` before writing any file, and the
  orchestrator re-dispatched both fresh, reasoning that "zero edits means resume equals fresh". The
  owner: "you don't need to fresh dispatch, you can message agents to resume them." A clean slate is
  not a clean context.
- The real defect was not consulting the written rule. A transient environment failure is the most
  predictable trigger for it.
- After the orchestrator process was killed (out of memory) and the session resumed, messages by agent
  NAME failed for all six agents ("no agent named ... is reachable"). The raw agent id worked.
- A resumed agent still believes the dead session is its addressee and may try to report there.

**How to apply:**

- On failure: first `git status` and `git diff` the agent's tree. Then message it to resume.
- Fresh dispatch only when the task changed, or when the agent had zero edits AND negligible priming.
  On a long, carefully fenced brief, priming is never negligible.
- Once a successor is running, never resume the original too: they share one report path and one
  scratchpad. Resume the LATEST attempt.
- After an orchestrator restart, find ids on disk: `~/.claude/projects/<project-slug>/<session>/ subagents/agent-<id>.meta.json`; `<id>` is the address.
- Tell every resumed agent: report to this session, write the report file first (it is the deliverable
  of record), and do not retry a failed send elsewhere.
- After a restart, do not wait on a resumed agent's message. On one day 3 of 4 resumed agents
  finished and went idle without their message reaching the orchestrator. Verify the work directly:
  the target remote branch, its CI run by `headSha`, the report file, and the agent's last transcript
  entries. A "message queued, agent already running" reply is not evidence it will act.
- If the resume itself is refused, follow \[[quote-a-refusal-before-substituting]\] before
  dispatching a fresh agent.
- A resume re-enters the agent's original model tier without passing through any dispatch-time check.
  Count it against the concurrency budget before sending.

Related: \[[concurrency-budget]\] \[[agent-liveness-and-ownership]\]
