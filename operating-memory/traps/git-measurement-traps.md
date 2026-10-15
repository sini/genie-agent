---
name: git-measurement-traps
description: When git output is used as evidence (diffs, logs, greps at a revision, hook messages)
type: trap
verified: 2026-10-15; git 2.55.0
---

**Rule:** Prefer identities that hold by construction (tree hashes, `rev-list --count`, `--quiet` exit codes) over absences read from human output. Never bundle short flags on `git grep`.

**Why / measured:**

- `git grep -lin` parses as the long option `--lin`, fails, writes the error to stderr and nothing to stdout. So `git grep -lin <term> | wc -l` returned 0 for EVERY term, including every positive control, with no visible error. Re-run correctly, the same sweep read `link` 7, `origin` 7, `facet` 5.
- An empty `git diff -- <path>` looks the same whether the file is unchanged or does not exist at that revision. Run `git cat-file -e <rev>:<path>` first, and run the positive control on the same path.
- `git grep <pat> -- <rev>` puts the revision in pathspec position. It silently searches the working tree while looking rev-pinned. The revision goes before `--`.
- `git log <empty-range> | wc -l` once read 1 on an empty range (a bare newline). On git 2.55.0 it reads 0 in every format tried, so the count depends on version and format. Use `git rev-list --count`, whose 0 is a number.
- A diff wrapper decorated piped output, so `git diff --name-only | wc -l` read 1 on an empty diff. Use `git diff --quiet` and read the exit code.
- `git log -S name` counts occurrences of the string. A body rewrite that keeps one occurrence before and after shows no commits. Use `git log -G` or read `git show`.
- A `git grep` zero means absent now; a `git log -S` zero means never present. You need both to tell a decayed anchor from a name that was never there.
- A pre-commit hook printed "4 files changed" while `git show --stat HEAD` showed 7. Verify what landed with `git show --stat`.
- `git log --format=%G?` prints `N` when the allowed-signers file is unset. That does not mean unsigned; check `git cat-file commit` for a `gpgsig` header.
- A working-tree grep is a measurement at an unnamed revision. Concurrent landings can make two greps straddle a commit.
- "Commit X introduced the defect" is a claim about two revisions. Twice an agent was wrong from reading the diff: the defect predated the commit, which had only turned a silent failure into a loud one. Reproduce at the parent.

**How to apply:**

- `git grep -l -i -e "$term" > out 2> err; echo "rc=$? stderr=$(wc -c < err)"`. Check stderr is empty before trusting any zero.
- Content identity: compare `git rev-parse <a>^{tree}` with `git rev-parse <b>^{tree}`.
- To show a file is unchanged under another agent's edits, use its content hash, never its mtime.
- Re-read at the revision you are about to edit before applying a fix.

Related: \[[git-worktree-and-remote-traps]\] \[[zsh-is-not-bash]\] \[[controls-for-absence-claims]\]
