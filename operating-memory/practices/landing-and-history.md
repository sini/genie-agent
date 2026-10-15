---
name: landing-and-history
description: When committing, merging, pushing or landing a unit of work onto main, and how often
type: practice
---

**Rule:** Commit after each verified logical unit. Land a gate-passed unit on its repository's
main in the same dispatch, by its own build agent. Keep history linear: rebase, never a merge
commit. Revert shared history forward-only, never force-push.

**Why:**

- Commits are sync points: peer agents review by pulling them, so batching stalls the loop.
  Messages must stand alone for a peer reader.
- **Exception: do not commit a generated export often.** 44 commits touching only a tracker
  export destroyed sha-based tree identity: every cross-revision claim then needed a scoped
  diff. Batch the export once per session phase.
- Every build brief in one session said "branch only (relock executing)", so about 20
  gate-passed units sat on branches, and closures fell to 5 against 37 creations in a day. The
  relock rule was narrow: no push to a repository's main *while a relock is executing on THAT
  repository*. One main sat free for four and a half hours.
- A diverged main integrated by `git merge` produced merge commits. Owner: "in the future,
  rebase instead of merge." One repository's branch rule rejects merge commits on push.
- A writer prompt said "you may push once green", and the writer pushed a change whose
  requirement the owner then challenged. The revert had to go forward-only; the force-push was
  correctly blocked.

**How to apply:**

- Build-brief default: commit and push to main once the gate is met, then fast-forward the
  shared local checkout. "Branch only" needs a stated reason: an owner-blocked base, a joint
  partner not yet landed, or a relock executing on that repository right now (check the
  process, not just "a relock is open").
- Land the base first, then branch from main. Do not stack builds on unlanded bases.
- Merge without PR ceremony where that is authorized: rebase or fast-forward and push, with
  the same green-suite and review requirements.
- Diverged: `git rebase origin/main`, then a fast-forward push. Never `git pull` without
  `--rebase`. In a shared checkout, tell the peer the new shas after a rebase.
- Push authority covers existing refs. Creating new remote ref namespaces needs explicit
  authority.
- Do not pre-authorize a push for a requirement the owner has not confirmed.
- Strip harness-injected trailers if the project forbids them, and add no co-author lines
  unless asked.
- Keep tool-generated scratch docs (default skill output directories) out of product
  repositories. Specs and plans live in the design repository.
- A memory asserting that a mechanism is ABSENT (for example "the commit hook is inert")
  expires silently. One hook went inert, then fired the full suite, then was installed
  without its config. Run the commit and read the error.
- Read CI after every push and prove publication (\[[ci-gate-discipline]\]).
- Red main after landing: the author of the red commit owns it, not the next agent. If one fix
  attempt does not find the cause, revert forward at once and report. A red main blocks all other
  landings until it is green or reverted. ("One fix attempt" is a provisional threshold.)

Related: \[[one-writer-per-checkout]\] \[[format-before-commit]\] \[[ci-gate-discipline]\]
