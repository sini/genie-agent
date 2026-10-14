---
name: claude-code-agent-messaging
description: When messaging, correcting, or collecting results from subagents and teammates
type: trap
---

**Rule:** A message reaches a working agent at its next tool use and does not preempt the response in progress. To stop an action before it happens, stop the agent. To get a result back, require explicit delivery.

**Why / measured:**

- Agents process their inbox only after a tool use, and keep going until they deliver their current response. A report written before the agent acted on your message can still say "no reply". Do not diagnose "unread inbox" from one crossed report.
- So a correction cannot stop an agent from acting on the brief it is already executing. A builder that was told mid-flight to drop an unauthorized change was in fact stopped half-way through adding it. Only the stop command did that.
- A teammate's final-turn text never reached the controller. Every dispatch must require delivery by explicit message or handback call.
- The agent-teams env var is read at startup, so a settings change needs a restart. Without a terminal multiplexer, pin `in-process` teammate mode.
- A queued message also resumes an idle agent.

**How to apply:**

- Urgent correction: stop the agent, inspect the worktree and remote branches for what landed, save any WIP as a patch, then re-dispatch with the corrected brief.
- Name every spawned teammate so messages have a predictable target.
- Before blaming messaging for latency, check what the agent did after the message arrived.

Related: \[[claude-code-discovery-traps]\] \[[verify-peer-agent-reports]\]
