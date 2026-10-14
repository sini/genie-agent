---
name: redirect-truncates-before-read
description: When a read-modify-write script rebuilds a file from a tool's output
type: trap
---

**Rule:** Gate every whole-file replacement on the intermediate being non-empty: `test -s body.md || { echo ABORT; exit 1; }`.

**Why:** `>` truncates the file before the command runs. In a near miss, the idiom `tool read > body.md; cat >> body.md <<'EOF' ...; tool write --from body.md` ran after a `cd` that broke the tool's workspace lookup. The read failed loudly, but `body.md` was already empty, so the append left only the new block. That file would have replaced a 38 KB record with 4 KB. The write failed only because it hit the same broken lookup. Re-running from the right directory to "fix" the visible error would have gone through and destroyed the record.

The loud failure and the destructive one are different events, and the loud one is not guaranteed to come first. The last command's exit code says nothing about whether the first stage produced its output.

**How to apply:**

- Check the read's exit status and that its output is non-empty before appending.
- Prefer a helper script that refuses on an empty payload, an empty current body, or a read-back that is not byte-identical to what was written.
- Prefer the editor or Write tool for generated files. Unlike a redirect, it refuses when the target changed underneath you.

Related: \[[read-exit-status-unpiped]\] \[[tracker-br-traps]\]
