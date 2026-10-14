---
name: ci-gate-discipline
description: Before and after publishing to a shared branch — whether a check is acceptable, whether a red may be published, how often to run an expensive check, and how to prove a push is published and landed (including repos with no CI)
type: practice
---

**Rule:** Checks stay pure; a red the local evaluator also shows is fixed before publishing; an
expensive check runs once on the final tree. A push is landed when the commit is an ancestor of the
remote branch, its content is still present at the tip, and that sha's own CI run is read green.
"The remote head equals my sha" is true only at the moment you check it.

**Why:**

- **Purity.** A one-word "agree" was read as consent to an arm needing `--impure`; the owner overrode
  it ("--impure shouldn't be necessary"). A pure route was found: each evaluator from its release
  flake, the running evaluator detected from pure builtins, 66/66 green across 22 projects and 3
  evaluators. An oracle that needs impurity is the wrong construction, not a price.
- **Local before publishing.** A relock pushed a commit CI showed red on all three evaluators (Nix,
  Determinate, Lix), already measured locally, because its brief said "publish even if a check reds".
  A failure on every evaluator is deterministic; publishing it only moves the owner's attention.
- **Local green, CI red.** gen-scope's CI was red for nine consecutive runs while "green verified before
  each push" was recorded each time. Hook and root `nix flake check` passed; CI ran in a `ci/`
  subdirectory under Determinate Nix, which refused a `builtins.toFile` referencing a store path
  without context that the local Nix did not even warn on.
- **Cost.** gen-demo's `refusals` plane was 217 serial evaluator processes at ~3 s (~11 min per run).
  A brief demanded it after each of six one-cell commits: ~66 minutes the per-cell evidence already
  covered; the owner noticed a landing crawling for over two hours.
- **Read-backs expire.** A builder read its own sha back from `git ls-remote`, correctly; within the
  hour another agent landed on top. A later auditor cannot tell "never landed" from "built upon".
- `gh run list --commit <short-sha>` matches nothing; four poll loops read empty for 30-40 minutes.

**How to apply:**

- When a construction reaches for `--impure`, a host store path or an eval-time environment read,
  look for the pure form (flake inputs, a documented seam, pure-builtin detection) before offering it.
  Say which arm you took on a terse "agree" so it can be corrected.
- Before any push, run the local gate. Only a red on ONE evaluator in CI, not locally, may be deferred
  as evaluator-specific. Reproduce a CI red with CI's own command in CI's own directory first.
- Landing briefs: cheap checks per commit, the slow plane once on the final tree; bisect only if it
  reds. Re-measure the cost after the runner gets faster.
- Prove publication:

```sh
git merge-base --is-ancestor "${mine}" origin/main; echo $?                 # 0: in the history
git show origin/main:path/to/file | grep -c 'my landed text'                # 1: still there
git show origin/main:path/to/file | grep -c 'fresh-random-token'            # 0: control, same run
git merge-base --is-ancestor origin/main "${earlier_real_commit}"; echo $?  # 1: ancestry control
```

The ancestry control is a REAL non-ancestor; a fabricated sha exits 128 (tests the parser). Read
exits unpiped.

- CI: `gh run list --branch main --limit 1`, `gh run view <id>`, `--log-failed`. Match a short sha via
  `--json headSha` and jq `startswith`. A run collecting zero checks is green and proves nothing:
  count checks, not green runs.
- Once per session, sweep the latest run of every repo you own, so a pre-existing red is found by you.
- A repo with no workflows has no run: say so and name the substitute (ancestry + tip content).
- Treat any read-back in a report as timestamped. After pushing, fast-forward the local checkout
  (\[[keep-local-checkouts-synced]\]).

Related: \[[landing-and-history]\] \[[reading-test-suite-output]\] \[[cap-every-heavy-evaluation]\] \[[success-signal-is-not-measurement]\]
