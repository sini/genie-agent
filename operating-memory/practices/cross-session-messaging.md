---
name: cross-session-messaging
description: When sending to another agent session or service over a cross-session message bus (xmsg), possibly on another host, and waiting for its reply
type: practice
scope: local
---

**Rule:** Send, carry on, and act on the reply when it is pushed into your session. Do not block on a
`replies` poll. Address sessions by the id a fresh `list` returns, never by a remembered label, and
hand over shared code as a pushed branch.

**Why:**

- Replies arrive pushed as cross-session messages whatever tool call is running. Owner: "No need to
  wait for replies, replies will reach you regardless of your toolcall." Repeated 60-second
  `replies` waits stalled turns for nothing.
- Session labels change from day to day; session ids persist. A name-shaped address returned
  not_found, and an old session id had dropped out of the list.
- The server renamed its target parameter (`ref` to `to`); a cached tool schema still offering the
  old name was refused with a message naming the new one.
- A session on another host cannot read your temporary directories.

**How to apply:**

- Use `replies` only to recover after a restart or a missed push.
- Run `list` with no filter to see every node's recipients and status, then send to
  `<sessionId>@<node>`.
- Push a repro branch before handing it to a session on another node.
- Route a request to the session that owns the work (a fix to the library's build session, a
  roadmap question to the orchestrator), not to whoever answered last.

Related: \[[relay-through-the-hub]\] \[[claude-code-agent-messaging]\]
