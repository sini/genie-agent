---
name: redirect-truncates-before-read
description: When a read-modify-write script rebuilds a file from a tool's output
type: trap
verified: 2026-10-15; zsh 5.9.2
---

**Rule:** Gate every whole-file replacement on the intermediate being non-empty: `test -s body.md || { echo ABORT; exit 1; }`.

**Why:** `>` truncates the file before the command runs. In a near miss, the idiom `tool read > body.md; cat >> body.md <<'EOF' ...; tool write --from body.md` ran after a `cd` that broke the tool's workspace lookup. The read failed loudly, but `body.md` was already empty, so the append left only the new block. That file would have replaced a 38 KB record with 4 KB. The write failed only because it hit the same broken lookup. Re-running from the right directory to "fix" the visible error would have gone through and destroyed the record.

The loud failure and the destructive one are different events, and the loud one is not guaranteed to come first. The last command's exit code says nothing about whether the first stage produced its output.

**How to apply:**

- Check the read's exit status and that its output is non-empty before appending.
- A store whose write REPLACES a whole record makes every append a read-modify-write. The read is
  non-deterministic under load: a read of a 454-line record returned the literal one-line string `null`
  (an accessor over an empty result), and the next read seconds later returned all 454. Read twice and
  refuse if either read is empty or `null` or the two differ; do not refuse on a fixed minimum length,
  since short records are legitimate.
- Verify by checksum of the preserved prefix after the write (`head -n <old line count> | md5sum`), never
  by line count: a truncated record plus a long block can have more lines than before.
- A store's own length guard refusing your write is a measurement that your read was short. Re-read;
  never answer it with a force flag, which turns a bad read into a lost record.
- Prefer a helper script that refuses on an empty payload, an empty current body, or a read-back that is not byte-identical to what was written.
- Prefer the editor or Write tool for generated files. Unlike a redirect, it refuses when the target changed underneath you.

Supersedes the general half of br-description-replace-is-read-modify-write (retired with the tracker-specific traps).

Related: \[[read-exit-status-unpiped]\] \[[controls-for-absence-claims]\]
