---
name: git-worktree-and-remote-traps
description: When counting worktrees, moving refs between hosts, or landing a push
type: trap
---

**Rule:** Treat worktree lists, clean fetches and "Everything up-to-date" as claims to verify, not as success signals.

**Why / measured:**

- A worktree created under `/tmp` keeps its registration in the repo's `.git` after reboot deletes the directory. One check of whether a build had left repos untouched read 3 worktrees where 1 was expected. All the extras were `prunable` orphans from other sessions.
- Worktrees whose `.git` file points at a path that has since moved still appear in `git worktree list`, while `git -C <tree> log` says "not a git repository". A git sweep and a filesystem sweep returned different sets. A "zero stale trees" result from one instrument was false: eight trees and 342 stale files remained. Grep sweeps that did not exclude `.worktrees/` confirmed stale claims against months-old copies.
- An archived GitHub repo accepts `ls-remote`, `fetch` and lock resolution. Only a push fails. Local `main` can diverge from `origin/main` permanently while `status -sb` looks normal.
- An agent ran `git checkout origin/main` in a shared checkout. A later `merge --ff-only` moved a detached HEAD, and `git push origin main` printed "Everything up-to-date" while the remote stayed at the old SHA.
- A fetch-style transfer (`fetch +refs/heads/*:refs/remotes/<peer>/*`) brings the objects but moves no local branch, so it reads as "nothing transferred". Uncommitted work and stashes never travel.
- A repo-wide post-checkout hook rewrote the shared repo's `core.hooksPath` on every `git worktree add`.

**How to apply:**

- Count worktrees as total minus `git worktree list | grep -c prunable`. `git worktree prune` is safe for prunable rows. Remove your own worktrees explicitly.
- Before deleting a tree with a broken pointer, diff the filesystem against the pinned revision. Git cannot tell you about uncommitted work there.
- Read the archived flag without mutating: `gh api repos/<owner>/<repo> --jq .archived`.
- Before a fast-forward landing, `git branch --show-current` must print `main`. After the push, the output must show an `old..new main -> main` range.
- After a fetch-style transfer, check ancestry with `git merge-base --is-ancestor`, then `git merge --ff-only refs/remotes/<peer>/main`.
- In a shared repo, prefer `git clone` into a scratch directory over `git worktree add`.

Related: \[[git-measurement-traps]\] \[[scratchpad-shared-across-agents]\] \[[per-machine-state]\]
