---
name: one-writer-per-checkout
description: When more than one agent (or you plus an agent) will write to one repository; worktrees per writer, and the git scoping ladder that explains why careful staging is not enough
type: practice
---

**Rule:** One writer per checkout, branch included. Parallel writers in one repo each get their own
git worktree; the orchestrator integrates serially from the main checkout. Count writers per REPO,
not per task: two writers on disjoint files still share the index and HEAD. Where a checkout is
genuinely shared, `git add <paths>` then `git commit -m … -- <paths>` in one breath, and verify the
commit by accounting, not by its exit code.

**Why:** each rung was measured, and each defeats the protection of the rung above it:

1. **`git commit` takes the whole index.** Staging by name protected nothing: a bare commit swept
   another agent's staged 229-line file into a push. `--amend` also amends *whoever's* commit is at
   HEAD; one agent destroyed another's commit message that way.
2. **A push takes the whole branch.** Two writers, both path-scoped: one push carried the other's
   un-gated commits to the public remote as ancestors.
3. **The pre-commit hook stashes tracked, unstaged changes across the whole worktree**, however the
   commit is scoped; a concurrent writer's tracked edits vanish during the hook run. Untracked files
   are NOT touched and a failed re-apply is loud; overstating the hazard cost two sessions ~30 minutes
   of needless serialisation.
4. **`git commit -- <paths>` applies to TRACKED files only.** Without a prior `git add` it exited 0
   having committed 3 of 18 files; the message claimed all of them.
5. **The index is shared.** Files left staged across a tool call get swept into the other writer's
   bare commit.
6. **Read-then-Write of a whole file** destroyed another agent's edit landed in between.

- Two doc agents plus the orchestrator committing to one repo produced divergent sibling commits;
  `origin/main` looked clobbered until a rebase recovered it. A `git checkout -- .` reverted another
  writer's uncommitted work and voided its test runs: green figures for a tree that never held the
  change. Two agents in separate worktrees both edited one shared docs file in a third repo; the
  second commit swept the first's hunks under a message naming only its own change.

**How to apply:**

- `git worktree add .worktrees/<task> -b wt/<task> HEAD` (explicit base; a harness default may branch
  from `origin/<default>` instead of your feature branch).
- Integration: commit the branch, rebase onto main, run the merge gate ON THE REBASED BRANCH,
  fast-forward from the main checkout, push, delete branch and worktree (only after the agent's final
  report is accepted).
- Never run integration git inside a worktree; a push there can create a stray remote ref. Check:
  `git ls-remote origin 'refs/heads/wt/*'` returns nothing.
- Every integration block starts with `cd <checkout>` AND `git branch --show-current` in the same
  command: a checkout sitting on the feature branch makes `merge --ff-only <branch>` a silent no-op.
- Repo-root sweeps double-count `.worktrees/` copies: use `git grep`, `git ls-files`, or
  `--exclude-dir=.worktrees`.
- Type `-- <paths>` as part of typing `commit`, even when you think you are alone. Never `git add -A`,
  `git add .`, or a directory add. Never `checkout --`, `restore`, `stash` or `reset` in a shared
  checkout. With a concurrent writer, use line-scoped edits only.
- Before committing: `git diff --cached --name-only` shows only what you named. After:
  `git show --stat HEAD` matches the message and `git status --porcelain | wc -l` is 0.
- Subagents in a shared repo WRITE FILES ONLY; the orchestrator is the sole committer, or each unit has
  its own worktree. If you commit for agents you told not to run git, you are a second writer.
- A cross-repo file (shared docs) goes to ONE dispatch, or every implementer leaves it uncommitted for
  the orchestrator. Dispatching an agent whose brief names a tracked path IS a write to that checkout.
- No tracker writes (which rewrite a tracked export file) while a commit runs in that checkout.

Related: \[[read-shared-trees-at-committed-objects]\] \[[peer-sessions]\] \[[landing-and-history]\] \[[format-before-commit]\] \[[concurrency-budget]\]
