---
name: formatter-check-is-not-a-format-run
description: Applies to Nix flakes using treefmt-nix, especially in linked git worktrees.
type: trap
verified: unverified
---

**Rule:** The only formatting signal is the formatter itself, run by path. A flake check whose name
mentions the formatter is not that run until you have read its build command.

**Why:** A check called `treefmt-tree-root` only asserted the formatter was CONFIGURED with a tree-root
option (it grepped the wrapper and `touch $out`). It formatted nothing. An orchestrator put "formatting
is covered by the flake check" into four dispatch briefs before a gate read the check. Measured: the
flake check green while the formatter read "35 emitted, 1 changed, exit 1".
Worse in a worktree: if treefmt's project-root detection walks for a `.git` marker, a linked worktree's
`.git` is a POINTER FILE, so the walk climbs out and formats the MAIN checkout while reporting success.
Setting the project root file to null (and passing the tree root explicitly) is load-bearing.

**How to apply:**

```sh
nix build ./ci#formatter.x86_64-linux -o fmt && ./fmt/bin/treefmt --fail-on-change; echo "rc=$?"
git status --porcelain
```

- When you bypass a pre-commit hook (e.g. config missing in a worktree), name each hook entry you ran
  and the exact COMMAND. A check whose name resembles the entry is not the entry.
- Read a check's build command before citing it as coverage.

Related: \[[treefmt-fail-on-change-writes-first]\] \[[nix-which-flake-which-output]\]
