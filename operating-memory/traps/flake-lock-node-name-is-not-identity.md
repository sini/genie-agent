---
name: flake-lock-node-name-is-not-identity
description: Applies when censusing or checking revs in a flake.lock with jq.
type: trap
verified: 2026-10-15; Nix 2.34.8, Determinate Nix 3.23.1, Lix 2.95.3
---

**Rule:** Read a rev by walking `.nodes | to_entries[]` (or by node PATH from root), never by a single
node NAME. A convergence predicate is "zero nodes at the stale rev", never "one node per input".

**Why:** Nix does not merge identical inputs reached by different paths. A lock carried `import-tree`,
`import-tree_2` (byte-identical `original` AND `locked.rev`) and `import-tree_3`. Relocking with an
override left both `original` objects identical and TWO nodes remaining (control: a single declaration
path gives one node). A census built from `jq '.nodes["import-tree"].locked.rev'` could not see `_2`
and `_3`, which were exactly the second declaration paths being censused: it returned 36 where the
true count was 41. Two competent agents disagreed 36 vs 41 before the cause was named. "One node per
lock" is unreachable by construction.

**How to apply:**

```sh
jq -r '.nodes | to_entries[] | select(.value.locked.rev? != null)
  | "\(.key) \(.value.locked.rev)"' flake.lock | grep -i "<name>"
```

- A depth-bounded census (e.g. `find -maxdepth N -name flake.lock`) changes answer with its bound
  (stale worktree locks sit deeper). State the bound beside the result.

Related: \[[repo-has-more-than-one-lock]\] \[[nix-override-input-silently-inert]\]
