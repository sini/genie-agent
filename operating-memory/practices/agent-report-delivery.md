---
name: agent-report-delivery
description: When a dispatched agent goes idle, reports "failed", or its report never arrives; how to make delivery reliable and how to recover
type: practice
---

**Rule:** Name a disk path for every deliverable, tell the agent the exact tool call that
delivers its report, and on a silent idle read the tree first and ping once. Never
re-dispatch on silence.

**Why:** In one session six of eight agents finished correct work and idled without
reporting. Every deliverable named as a file path was recovered from disk; the one named
only as "report the census" was lost with its agent's context and had to be re-run by hand.
Other measured facts:

- A teammate revived by message has no automatic return channel: its final text goes to its
  own transcript. Words like "reply", "return" or "your final message" all fail. Give the
  call literally: `SendMessage({to: "<lead>", message: "<THE ENTIRE REPORT>"})`.
- A new agent family once shipped with a "send your report" instruction and without the send
  tool in its tool grant. The agents complied exactly and nothing arrived. **Check the grant
  before writing the rule.**
- An `idleReason: failed` notification was followed by full delivery four times out of four.
  It reports a transport event, not the agent's state.

**How to apply:**

1. Close every prompt with the delivery instruction AND "if an attempt fails and writes
   nothing, say so": a clean abort looks exactly like work never started.
2. On idle with no report: check the artefact (`md5sum`, line count, grep for the round's
   change), then the agent's transcript file, then ping once, naming the tool.
3. A recovery premise is perishable: send it with the clock time and "re-check before
   acting; if this has moved, say so and stop". "Artefact unmoved" means death only if the
   brief admits an edit as the sole outcome.
4. **A report is not a release.** With tool delivery, the report can arrive minutes before
   the agent stops. One writer per file holds until the idle notification.
5. **A message to an idle agent resumes it as a live writer.** A follow-up is a dispatch:
   send it OR start a fresh agent, never both, and count it against the fleet cap.
6. "Idle, waiting on my background run" can be a permanent stall. If the outputs are done
   and no process of the agent's is alive, message it once with what finished.
7. A killed session's scratchpad survives on the host it ran on until cleanup. Recover and
   byte-verify it before restarting; let fresh agents regenerate lost findings rather than
   paraphrasing them yourself.

Related: \[[relay-through-the-hub]\] \[[read-shared-trees-at-committed-objects]\] \[[kill-only-captured-pids]\]
