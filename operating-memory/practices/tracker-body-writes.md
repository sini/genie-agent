---
name: tracker-body-writes
description: When writing findings, rulings or obligations into an issue tracker (beads/br or similar) from a shell tool
type: practice
---

**Rule:** Write findings into the item's DESCRIPTION, not into comments or notes. Pass the
prose from a FILE, not as a command-line argument, and verify the stored text by reading it
back.

**Why:**

- Owner: "We don't use comments generally, we append directly to the body as nobody ever reads
  the comments." Comments were append-only (no edit or remove) and unread, so anything
  load-bearing there was invisible in practice. The body is what boots, gates, briefs and the
  agenda script read. Seven comments across six rows were written in one session despite the
  rule already being written down.
- Prose passed in zsh double quotes was mutated silently. A backticked control name was
  command-substituted away, leaving "live control ⇒ 9 same run" with the control unnamed.
  `visible ? key` was globbed and vanished (`zsh: no matches found: ?`). The tracker reported
  "appended 3675 chars", exit 0. The holes show only when you read the field back.
- `-d "<body>"` on a real body hit `Argument list too long`.
- An agenda script matched title and description only, so three forks banked in comments or
  notes read 0.

**How to apply:**

- Read the current body, append a dated block, and write the whole body back with
  `--description-file <path>`. A shrink below half the current length needs `--force`: that
  guard is deliberate, so think before using it.
- Use a wrapper that reads the payload from disk and refuses on an empty payload, an empty
  current body, or a read-back that is not byte-identical.
- Write the payload with a file-writing tool, not a shell heredoc.
- Where an argument is unavoidable (a short title, a `--reason`), SINGLE-quote it. Single
  quotes are literal in zsh.
- Model-facing commands use native text output (\[[json-for-programs-text-for-models]\]).
- After banking, run the deriving query (agenda, ready list) and confirm the row appears.
- Bodies are self-contained: markdown outside the tracker does not survive compaction, and the
  graph does.

Related: \[[durable-records-not-handoffs]\] \[[filing-caps]\]
