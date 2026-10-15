---
name: repo-has-more-than-one-lock
description: When relocking a repository, checking that its locks are current, or trusting a library's own suite as evidence its published surface works
type: trap
verified: unverified
---

**Rule:** Enumerate every lock in a repository before calling a relock complete. A suite passing is not
evidence the published surface works, and two locks agreeing proves consistency only: to claim
currency, compare each lock to the upstream tip.

**Why:** Measured:

- A library bumped a sibling's pin in `ci/flake.lock` but not the ROOT lock. Its own suite (which
  resolves `ci/`'s lock) read 297/297 green, while every real consumer (which resolves the root lock)
  threw "attribute '<newExport>' missing". Same probe, both locks: false at root, true at ci.
- On a hub, the root `nix flake update` moved 7 nodes; `ci/` had its own lock and its update moved 13,
  6 outside the unit. Relocking only the root left the `ci/` half undone and reading clean.
- A sub-sub-flake carried a third, hand-maintained lock that neither act touched.
- A hub's root lock and `ci/flake.lock` agreed 21/0 while BOTH predated all 21 member updates. The
  check compared them to EACH OTHER. Its shipped arm also exited 0 even when its own agreement flag was
  false (observe-only), so even the consistency claim needed reading the output, not the rc.
- A suite figure measured before a relock was relayed as standing; the relock alone regressed it.
  Every figure is a snapshot.

**How to apply:**

- `find . -name flake.lock -not -path '*/.git/*'` and handle each.
- When a change depends on a new export from a sibling, check the ROOT lock's pin, or drive the
  consumer path (a downstream's own check, or `nix eval .#lib --apply 'l: l ? newExport'`).
- For currency: for each input, compare `locked.rev` to `git ls-remote <url> HEAD` (or the branch).
- Read what a check asserts, and whether it enforces or only observes.

Related: \[[nix-override-input-silently-inert]\] \[[flake-lock-node-name-is-not-identity]\] \[[lockfile-minimal-delta]\]
