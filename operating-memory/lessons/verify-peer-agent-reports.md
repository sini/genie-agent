---
name: verify-peer-agent-reports
description: When another agent (a different harness, a teammate, a delegated builder) reports work as done
type: practice
---

**Rule:** Verify every delegated agent's report yourself, with a mutant (a planted break that must turn the suite red) and the full test total. Keep a delegated agent's assigned work in a file it can re-read, because it may compact.

**Why / measured:**

- A delegated agent undercounted test totals, and once shipped a fail-open client covered only by mock tests.
- An agent that acts only during a turn left messages sent while it was idle waiting until the owner prompted it. Its work queue lived in a file updated on every dispatch and every landing, so it could recover after compaction.
- An external-messaging bridge passed one review round with a hole: HTTP replies trusted a session reference from the request body. The next unit closed it by routing identity-bearing operations only over a local socket attested by peer credentials. Lesson: check where every claimed identity comes from, not just that a check exists.
- A gate rejected the first published version of that bridge for a forgeable badge and identity taken from the body. It was accepted on the second contact with conditions.
- Version tags added by an overzealous agent were later deleted because the project was pre-release. Never describe a pre-release project as released.

**How to apply:**

- Re-run the agent's claimed command, read the exit code unpiped, reconcile the count, and run one planted mutant.
- Own the queue file, and point the agent at it on every dispatch.
- Push authorization is per session and explicit. It is not inherited from an earlier session or a relayed brief.

Related: \[[claude-code-agent-messaging]\] \[[claude-code-permission-classifier]\]
