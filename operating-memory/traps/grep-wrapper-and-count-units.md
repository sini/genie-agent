---
name: grep-wrapper-and-count-units
description: When grep/find/diff counts are reported as evidence, especially on a host with shell wrappers
type: trap
verified: 2026-10-15; GNU grep 3.12
---

**Rule:** Run the real binary by absolute path for any reported count. Say which unit the figure is in, and compare only counts taken with the same binary, flags and path argument.

**Why:**

- On one host `grep` was a shell function wrapping ugrep, which honours `.gitignore` when recursing from `.`. It found 14 hits where the real binary found 436.
- The wrapper also refuses patterns it deems too complex: "exceeds complexity limits" goes to stderr and nothing to stdout. A subagent got 12 consecutive empty results at the 12 sites it most needed. The real binary gave 12 of 12 non-empty. A positive control on a simpler pattern still passes, so it does not rescue the claim.
- A `find` wrapper refused `-not`/`-exec` at exit 1. With `2>/dev/null`, a design doc read as "absent".
- `diff` was wrapped in one session and not in the next. Carrying "diff is wrapped" as a standing fact produced a false RED: a working instrument was distrusted.
- Three units: `grep -c` counts lines, `grep -o | wc -l` counts occurrences, `grep -rc | wc -l` counts files scanned (it prints zeros too).
- On a file GNU grep classifies as binary (as few as three NUL bytes, or math unicode), `-c` still counts lines while `-o` prints "binary file matches" to stderr and 0 to stdout. 36 vs 0 on the same term looked like a contradiction. `-a` gives the truth.

**How to apply:**

- Run `type grep find diff` each session. Wrapping is per-session, not standing.
- Use `/run/current-system/sw/bin/grep` (NixOS) or the equivalent real path for evidence. Note that `/usr/bin/grep` may not exist.
- Use `-a` on extracted text. The control must use the same output form (`-c` vs `-o -n`) as the sweep.
- State the unit next to every figure.

Related: \[[read-exit-status-unpiped]\] \[[grep-wrapped-prose]\] \[[controls-for-absence-claims]\]
