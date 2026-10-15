---
name: read-exit-status-unpiped
description: Applies to every command whose success you are about to report, and whenever a measurement pipes, filters, chains or captures a command's output.
type: trap
verified: 2026-10-15; zsh 5.9.2, GNU grep 3.12
---

**Rule:** Capture output to a file and read `$?` directly: `cmd > out 2> err; echo "rc=$?"`. Then
inspect `out` and `err`. Never filter, pipe-count or `&&`-chain the output of a command whose failure
you have not already ruled out. An empty filtered result is an absent measurement, not a zero.

**Why:** In `cmd | wc -l` or `cmd | head`, `$?` is the status of the last stage. Measured incidents, all
reading as clean success:

- Four tracker `create` calls were piped through `grep 'Created'`. The tool was failing, grep matched
  nothing, nothing printed, and all four records were silently never created.
- A failing `nix-instantiate` piped to a filter; a busy database read (rc 2) piped into grep.
- A missing binary (exit 127) piped onward: `grep -c X f 2>/dev/null | wc -l` returned `0`; a markdown
  renderer not on PATH piped into a table counter read "0 tables". Both are false absences.
- No `2>/dev/null` is needed to fake an absence: `count=$(git grep -c ... | paste -sd+ | bc)` on a host
  without `bc` printed "command not found" to stderr and nothing to stdout. Three repos read 0,
  including the live control.
- A `check1 && check2 && check3` verification chain stopped at the first `grep -c` that returned 0, the
  answer you wanted, because grep exits 1 on no match. Every skipped assertion read as passed.
- `cmd 2>&1 | wc -l` on an absence claim counted symlink warnings on stderr as matches, turning a true 0
  into 2.
- Missing binaries also come from fixed paths: on a NixOS host `/run/current-system/sw/bin/` may lack
  `python3` or `jq` although they are on PATH, and `/nix/store/...` paths go stale after a rebuild.
  Call tools bare.

**How to apply:**

- `cmd > out 2> err; rc=$?; echo "rc=$rc"; wc -c < err`. Filter only afterwards, for display.
- If you must pipe: `$pipestatus` in zsh, `$PIPESTATUS` in bash.
- Treat rc 127 as "tool missing", never as data. Confirm every helper in a pipeline exists
  (`command -v bc`) before trusting a computed number. Prefer `grep -o ... | wc -l`.
- Write chained checks as a loop that prints a value per item, never as `&&`.
- In a write combining several flags where one flag is rejected, assume NONE of it applied: a status
  change sent with an unknown second flag exited rc 2 and the status never changed, while the agent
  reported its claim released. Make one change per write and read the state back. A relation-wiring
  write with its two arguments swapped is silent too; read the edge back from both ends.
- Keep stderr visible on any measurement; the error text is part of the measurement.
- The tell is the control: a broken pipeline zeroes the live control too. Read the control's value,
  not just its presence.

Supersedes the general half of br-multi-flag-write-applies-nothing and the dependency-direction item of tracker-br-traps (retired with the tracker-specific traps).

Related: \[[zsh-is-not-bash]\] \[[controls-for-absence-claims]\] \[[grep-wrapper-and-count-units]\]
