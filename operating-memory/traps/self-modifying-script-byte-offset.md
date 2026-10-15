---
name: self-modifying-script-byte-offset
description: Applies to git hooks, devshell startup scripts, or anything that may rewrite a script currently running.
type: trap
verified: 2026-10-15; bash 5.3.15
---

**Rule:** Never write in place over a file that may be executing. Write to a temp file in the SAME
directory and `mv -f` it over the target.

**Why:** A `post-checkout` hook ran `nix develop`, whose shell startup did
`cat > .git/hooks/post-checkout`: the running hook rewrote itself. bash reads a script incrementally by
byte offset, so after the write it executes whatever sits at that offset in the NEW file. Measured on
three arms: replacement byte-identical => 1 invocation (the control, and why it hid); LONGER => 2
invocations; SHORTER => the tail silently dropped, rc 0. It behaves correctly in the steady state and
misbehaves exactly when the tool is upgraded, which is when the hook matters. A self-modifying artefact
whose correctness depends on the SIZE of the modification has no construction, only a coincidence.
Sibling: an unguarded `x=$(git rev-parse ...)` in a startup string gave rc 1 and a write into `/hooks/`
without `set -e`, and rc 128 aborting the shell with `set -euo pipefail`.

**How to apply:**

```sh
tmp=$(mktemp "$dir/.hook.XXXXXX") && generate > "$tmp" && chmod +x "$tmp" && mv -f "$tmp" "$dir/hook"
```

- The running process keeps the old inode and finishes coherently; the next run gets the new file.
- Guard every command substitution in startup code: `d=$(git rev-parse --git-common-dir) || exit 0`.

Related: \[[redirect-truncates-before-read]\] \[[hook-wiring-is-disposable]\]
