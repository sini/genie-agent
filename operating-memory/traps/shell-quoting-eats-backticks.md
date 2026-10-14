---
name: shell-quoting-eats-backticks
description: When shell text carries markdown prose (commit messages, tracker bodies, close reasons)
type: trap
---

**Rule:** Single-quote any prose passed to a shell. Use `<<'EOF'` (quoted delimiter) heredocs or a `--file` flag for markdown. Never put markdown in a double-quoted argument or an unquoted heredoc.

**Why:** Any double-quoted shell context runs backticked spans as commands and substitutes their output.

- An unquoted heredoc writing a tracker body turned `` `specs/x-spec.md` `` into an attempt to execute a `.md` file. It failed loudly and the span was replaced with nothing.
- The silent arm is worse. A close reason written as `--reason "...prose..."` lost three backticked words (`function`, `never`, `gm`) to command substitution. The tool printed success. The only signal was `command not found: never` on stderr after the write. The sentence read grammatically with holes in it.
- Repairing it cost two spurious status transitions (reopen, re-close), because the tool had no flag to edit a close reason.
- `printf` interprets `%` directives: a commit message containing `(3.2%)` was truncated mid-word.

**How to apply:**

- Prose to a CLI: `cmd --reason 'text with `ticks`'` or write the text to a file with a quoted heredoc and pass the file.
- If you need a variable inside the text, build the file with a quoted heredoc and substitute afterwards with `sed`, or build it in two parts.
- Use heredocs, not `printf`, for messages that may contain `%`.
- After the fact, a stray "command not found" on stderr next to a successful write means the record was damaged. Re-read it.

Related: \[[redirect-truncates-before-read]\] \[[zsh-is-not-bash]\]
