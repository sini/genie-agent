---
name: public-collaboration
description: When creating a repository for an open project, or when a collaborator asks an assistant agent for a fix
type: practice
scope: local
---

**Rule:** Develop in the open: create project repositories PUBLIC unless told otherwise. When a
trusted collaborator asks for a fix "as a patch or PR", open the PR (where you hold that
standing permission) rather than handing them a patch, after checking that they have not
already opened one.

**Why:**

- A new ecosystem repository was created private out of habit, and the owner flipped it the
  same minute: "make the repo public, we develop in the open." A private repo is not a safer
  default; it is a deviation the owner has to notice and undo.
- Handing a collaborator a `git am` patch made them apply it and open the PR themselves. The
  owner wanted the PR opened directly, and turned a one-off approval into a standing grant.
- On one occasion the collaborator opened their own PR from an earlier patch while the agent
  was pushing a duplicate branch. The duplicate had to be deleted.

**How to apply:**

- `gh repo create <org>/<name> --public` for anything in the open ecosystem. If you find a repo
  private, say so; do not assume it was meant.
- For a PR: a branch, a commit with the configured author and no co-author line, a
  `## Summary` plus validation body, and a link to the issue. Then watch CI and report back in
  the thread.
- Before pushing, list the upstream's open PRs from that collaborator.
- In artefacts (code, comments, commits), credit reports generically ("reported in chat").
  Name people only where the venue expects it, such as a PR body.
- If the permission classifier refuses a push that creates a public surface, tell the owner.
  Do not route around it.

Related: \[[landing-and-history]\] \[[settings-via-config-management]\]
