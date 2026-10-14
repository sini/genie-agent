---
name: scratchpad-shared-across-agents
description: When deciding where probes, scripts, reports or retained artefacts live, naming scratch files, or symlinking a long scratchpad path
type: trap
---

**Rule:** Scratch space is volatile and shared. Anything someone will re-read goes into the repository's
reports directory and is committed; never cite a `/tmp` path as durable. Prefix every scratch file with
your task id AND role (`<task>-<role>-<name>`), prefer the `Write` tool over shell redirects, and
before trusting a scratch artefact you did not watch yourself write, check its mtime and provenance.

**Why / measured:**

- `/tmp` is a tmpfs: a reboot or a host move loses it. Committed records citing a "retained" probe under
  a shared `/tmp` handle became unresolvable coordinates.
- Two agents on unrelated tasks both wrote `sweep2.sh`. The second write was caught only because the
  Write tool refuses to overwrite a file the caller has not read. A `cat > ... <<'EOF'` would have
  overwritten it at exit 0, and the victim would see a probe that "measures the wrong thing", which
  reads as a finding, not an instrument failure.
- One task commonly gets a spec round, a gate, a fix round and a re-gate in one session. A fix round's
  first "green" was the gate's `green.txt` for the same task; its own chain had short-circuited and
  never written the file. Namespacing by task id alone is not enough: that is exactly what two agents
  on one task collide on.
- One-writer-per-worktree does not cover this: the scratchpad is outside every worktree. The same hazard
  reaches `~/.cache/` when two agents pick the same dated directory.
- Per-session scratch paths are ~110 characters and were retyped as a prefix in 900+ calls (about 335K
  tokens). The fix "symlink it to /tmp/sp" told every concurrent session to claim the same name: two
  agents found `/tmp/sp` re-pointed under them mid-flight, one resolving into a different session's
  tree; six live `sp*` links existed at once. A re-pointed symlink is followed silently by `cat >`,
  `sed -i` and every redirect, which write into the other session's tree at exit 0. It surfaced only
  because the Write tool refuses on a changed resolution. The convention's documentation also outlived
  the host it was written on.

**How to apply:**

- Use your own scratchpad per session (the harness-provided one, or `mktemp -d`). Shell state does not
  persist between tool calls, so symlink it once at boot under a SESSION-UNIQUE name:

```sh
FULL=<the session scratchpad path>
SP="/tmp/sp-$(basename "$(dirname "$FULL")")"   # suffix from the session's own id
ln -sfn "$FULL" "$SP"
```

- Subagents of one session share its scratchpad; the suffix distinguishes sessions, the
  `<task>-<role>-` prefix distinguishes agents. Put the naming line in every dispatch brief, since the
  rule does not enforce itself.
- Delete or overwrite your result file at the START of a run, so a stale file cannot pass as yours.
  `stat -c %y file` before trusting one.
- If a path behaves oddly, `readlink -f "$SP"` first, and always before handing it to a `path:` flake ref.
- Write generated scripts once to `$SP/<name>` and run by path.
- Name a retained report for its unit, and check that the path is free before writing.

Related: \[[nix-path-flake-ref-through-symlink]\] \[[heredoc-control-characters]\] \[[git-worktree-and-remote-traps]\]
