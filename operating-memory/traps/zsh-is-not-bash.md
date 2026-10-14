---
name: zsh-is-not-bash
description: Applies when an agent harness runs shell commands under zsh (check `echo $ZSH_VERSION`) while the agent writes bash, including loop variable names and patterns.
type: trap
---

**Rule:** Check which shell actually runs your commands, then write for it. Under zsh: quote every
expansion, brace any expansion followed by `:` or `[` (`"${sha}:path"`, `"${b}[^:]*"`), use arrays
instead of word-splitting, never name a variable `path` or `status`, and read exit status unpiped.

**Why:** Measured differences:

| bash idiom                                                       | in zsh                                                                                                                                     | failure                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `${!var}`                                                        | unsupported; use `${(P)var}`                                                                                                               | loud: bad substitution                                                                                       |
| unquoted `$list` word-splits                                     | stays ONE word                                                                                                                             | SILENT: a sweep passed one concatenated path to grep and every count, including the positive control, read 0 |
| `$PIPESTATUS`                                                    | `$pipestatus` (lowercase)                                                                                                                  | silent empty                                                                                                 |
| `shopt`                                                          | `setopt`                                                                                                                                   | loud                                                                                                         |
| `"$sha:lib/x.nix"`                                               | `:l` (also `:h :t :r :e :s`) is a history modifier on `$sha` => `<sha>ib/x.nix`; this applies to `$var:` anywhere, not only git `rev:path` | SILENT: with `2>/dev/null`, `git show` returned 0 lines for every commit, a clean empty history scan         |
| assigning `path=...`                                             | `path` is a tied array bound to `PATH`; `cdpath`, `fpath`, `manpath`, `mailpath` likewise clobber their scalar twins                       | SILENT: every external command vanished; only `command not found` on stderr                                  |
| `for status in a b`                                              | `status` is read-only                                                                                                                      | loud: `read-only variable: status` (agents reach for it when iterating tracker statuses or exit codes)       |
| `"$b[^:]*"` in a pattern                                         | parsed as an array subscript                                                                                                               | loud: `bad math expression: operand expected at '^:'`                                                        |
| unquoted word starting with `=` (`echo =====`, a separator line) | `=cmd` expands to the path of `cmd` (EQUALS option)                                                                                        | loud but easy to misread: `zsh: ==== not found`, rc 1, the command never runs                                |

Do not "fix" it by flipping the harness shell if existing docs instruct zsh idioms: in bash,
`$pipestatus` is simply unset, so every such exit check silently reads clean.

**How to apply:**

- `"${sha}:lib/x.nix"`; `"${b}[^:]*"`; `files=(a b c); grep -c foo "${files[@]}"`.
- Loop variables: `st`, `state`, `row`, `p`, `dir`. Never `path`, `status` or another tied/special name.
- Quote separator lines (`'====='`) or `setopt noequals`.
- Want a bash idiom? `bash -c '...'`.
- Read status unpiped: `cmd > out; echo $?`.
- The `path`, `:` and word-split forms fail silently; re-check output after any loop that uses a new
  variable name, and keep a live control in every sweep.

Related: \[[controls-for-absence-claims]\] \[[read-exit-status-unpiped]\]
