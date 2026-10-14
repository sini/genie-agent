---
name: br-multi-flag-write-applies-nothing
description: Applies when releasing a claim or changing status with br, or any CLI write combining flags.
type: trap
---

**Rule:** Do one change per write command, read its exit status unpiped, and read the state back.

**Why:** `br update <id> --status open --comment "..."` exits rc 2 with "unknown flag", and the
`--status` half does NOT apply either. An agent believed it had released its claim, reported so, and
the row stayed `in_progress` until it re-ran the bare form. A release that never happened makes the
tracker lie, and the only tell was the exit code.

**How to apply:**

- `br update <id> --status open; echo "rc=$?"`
- Add the note as a separate `br comments add <id> "..."`.
- Confirm with a read-back of the status.
- General shape: in a multi-flag write where one flag is rejected, assume NONE of it applied.

Related: \[[read-exit-status-unpiped]\]
