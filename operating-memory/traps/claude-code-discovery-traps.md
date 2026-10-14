---
name: claude-code-discovery-traps
description: When relying on Claude Code to load AGENTS.md, a skill, or a tool such as Agent
type: trap
---

**Rule:** Assume nothing loads unless you have measured it loading. Bridge `AGENTS.md` from `CLAUDE.md`, put skills at `.claude/skills/<name>/SKILL.md`, and load deferred tools by exact name before declaring them unavailable.

**Why / measured (Claude Code 2.1.x; re-check on upgrade):**

- `AGENTS.md` alone was not auto-loaded. A one-line `CLAUDE.md` containing `@AGENTS.md` loaded it. A string in the CLI bundle suggesting otherwise came from migration prose and was wrong. Several repos had been running on memory alone because they had a large `AGENTS.md` and no `CLAUDE.md`.
- A flat `.claude/skills/<name>.md` is not discovered. Frontmatter that had collapsed into a `##` heading meant a skill never registered while docs advertised it. A symlinked skill directory IS followed, so canonical content can live elsewhere.
- `claude plugin list` printed an empty skills heading for a real skill directory. Its zero is not an absence.
- A `.gitignore` entry `AGENT*` would silently refuse a later `git add AGENTS.md`.
- The `Agent` tool can arrive deferred. A keyword tool search did not return it, and a session declared "cannot dispatch" and stopped. The owner had to correct it.

**How to apply:**

- Probe with a non-interactive, tools-forbidden run on a small model, asking which instruction files or skills are in context. Always pair it with a nonexistent name as a negative control, because a small model will answer YES just because `AGENTS.md` is mentioned.
- Use `git add -f` for a tracked symlink inside an ignored `.claude/`.
- At boot, if `Agent` is not callable, run tool search `select:Agent` before claiming dispatch is impossible.

Related: \[[claude-code-agent-messaging]\] \[[claude-code-hook-delivery]\]
