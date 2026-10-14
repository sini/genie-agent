---
name: br-truncation-notice-on-stderr
description: Applies when capturing any br list/ready output to a file.
type: trap
---

**Rule:** Pass `--limit 0` on every br list/ready read you capture. If you must use a small limit,
redirect BOTH streams.

**Why:** br writes rows to stdout and its truncation notice ("[note] Showing 3 of 153 ...") to stderr.
Measured: `br ready --limit 3 > file` produced a short file with no notice, while the 69-byte warning
went to the terminal and was lost. A short capture reads exactly like a complete one. The bare form
(no `--limit`) was measured byte-identical to `--limit 0` on that version, so `--limit 0` is not about
a default cap: it is the form that emits no notice to lose (stderr: 0 bytes).

**How to apply:**

- `br ready --limit 0 > out.txt` for a full population.
- Any bounded read: `br ready --limit 5 > out.txt 2>&1`, then check for the note.
- Treat any count derived from a capture as unproven until you know nothing went to stderr.

Related: \[[br-native-text-for-models]\] \[[harness-elision-is-not-a-population]\]
