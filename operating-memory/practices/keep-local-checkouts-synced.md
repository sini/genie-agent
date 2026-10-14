---
name: keep-local-checkouts-synced
description: Before starting multi-repo work, and after any push to a repo that has a local checkout.
type: practice
---

**Rule:** The orchestrator and its agents own local repo state. Pull every target repo before
multi-repo work, and fast-forward a repo's local checkout in the same act as pushing past it.

**Why:**

- A build pushed a library's main forward, and the shared local checkout was left two commits behind.
  The orchestrator reported the drift instead of fixing it. Owner: "you should keep local repos in
  sync; you and your agents own the state."
- A library checkout once sat one commit behind its remote at the start of work, and a cleanup commit
  had to be rebased after the fact.

**How to apply:**

- After any push to a main, by you or an agent, fast-forward that local checkout. A fleet-wide sync
  command (clone what is absent, fast-forward what is present) belongs at boot and after each landing
  wave.
- Every dispatch granting commit+push says "after pushing, fast-forward the local checkout".
- This never licenses a stash, reset or pull over a dirty or diverged shared checkout. Report that
  checkout; do not force it.
- History is linear: rebase, never merge.

Related: \[[ci-gate-discipline]\] \[[peer-sessions]\]
