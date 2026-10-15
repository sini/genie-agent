---
name: heredoc-control-characters
description: Applies when a shell tool call would contain an inline heredoc with escape/control characters.
type: trap
verified: unverified
---

**Rule:** Put any script containing control or escape characters into a file with the `Write` tool and
run it by path. Do not retry the inline form.

**Why:** Agent harnesses may reject a command containing control characters before it runs (the
approval dialog would hide them): "contains control characters that would be hidden". Retrying burns
calls. Writing the file also avoids the heredoc-overwrite hazard in shared scratch space.

**How to apply:**

- `Write` -> `$SP/<task>-<name>.py`; then `python3 "$SP/<task>-<name>.py"`.
- Reuse the file instead of re-inlining the same heredoc.

Related: \[[scratchpad-shared-across-agents]\]
