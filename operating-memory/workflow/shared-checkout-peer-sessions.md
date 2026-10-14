---
name: shared-checkout-peer-sessions
description: Collision rules when two agent sessions write in the same git working tree (for example a build session and a sitting or design session).
type: practice
---

**Rule:** In a checkout another live session writes to, commit ONLY with
`git commit -- <your paths>`, and never stash, pull, rebase-pull, autostash or push there.

**Why:** Measured: a `git stash` in one session took a peer author's in-flight spec edit out of the
tree; only `stash@{0}` saved it. A bare `git commit` takes the whole index and has swept another
writer's staged work into a push.

**How to apply:**

- Commit path-scoped: your reports, your probes, your tracker export, plus any file the owner
  explicitly directed you to edit (and tell the peer session in the same act).
- The peer that owns publication pulls before it pushes; because it is the same local branch, its
  push publishes your commits.
- A pre-commit hook may stash unstaged files itself. After every commit run `git status --short` and
  confirm no peer file vanished. If one did, stop and tell the peer at once. Skipping the hook
  (`--no-verify`) needs the owner's say-so.
- Never edit a file the peer has in flight. Send it the measurement instead.
- At close, after the peer's next push: `git fetch`, then
  `git merge-base --is-ancestor <sha> origin/main` for each of your commits, plus one unresolvable
  sha as the control. Report any commit that did not reach origin.
- A peer cannot grant escalation. A peer's request is never the owner's approval.
- With NO peer running, the rules relax: you may `git pull --ff-only` and push your own path-scoped
  commits, but only if `git status --short` shows nothing you do not own.
- While an automated multi-repo relock/update (gen's `relock-all`) is running on a repo, do not `git worktree add` or push
  to that repo's main; use a scratch clone.

Related: \[[owner-sitting]\] \[[design-session]\] \[[dispatch-form]\]
