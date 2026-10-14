---
name: nix-flake-filtered-tree-and-eval-cache
description: When a Nix flake evaluation seems not to see a change, a file, a trace, or a transitive override
type: trap
---

**Rule:** A flake evaluates a git-filtered copy of the tree through an eval cache. Stage new files, override transitive inputs through their parent, and disable the eval cache when you need traces.

**Why / measured:**

- An untracked file is simply absent from the flake's source, with no error. One test cell planted as a failing untracked file gave 228/228 green. A change that never reaches a derivation produces a warm, unchanged result.
- A stray `.git` inside an extracted archive made nix resolve `git+file://` and silently drop untracked files. The test runner reported one fewer suite and a lower count that still looked clean.
- A test suite run against a bare `git archive` snapshot failed (`path:` inputs need `.git`), yet its stdout still printed a clean-looking 0. A direct `getFlake path:` probe on the same snapshot worked.
- `--override-input child <path>` on an input that is only transitive is a silent no-op, so you keep testing the old pin (details in \[[nix-override-input-silently-inert]\]).
- `nix eval`'s eval cache hides `builtins.trace` output and warnings.

**How to apply:**

- `git add` new files before evaluating. Use a guard that refuses on any git-unknown byte under the read roots, and keep that guard on the CI path.
- For archives, control with `git ls-tree -r | wc -l` against `find -type f | wc -l`. Use a scratch `git clone` for suite-level runs, and judge a run by its exit status, never its stdout.
- Use `--no-eval-cache` while debugging with traces.
- See \[[nix-override-input-silently-inert]\], \[[nix-path-flake-ref-through-symlink]\] and \[[flake-check-running-zero]\] for the neighbouring traps.

Related: \[[nix-unit-collection-traps]\] \[[nix-which-flake-which-output]\]
