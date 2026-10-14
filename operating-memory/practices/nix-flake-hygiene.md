---
name: nix-flake-hygiene
description: When creating files in a flake, bumping a pinned input, or writing Nix attrsets — staging, targeted lock bumps, idiomatic style, file splitting.
type: practice
---

**Rule:** Stage new files before any Nix command must see them. Bump one transitive input by its full
resolution path, not by re-locking the whole closure. Write idiomatic Nix.

**Why:**

- Flakes read a git-filtered tree. An untracked file is invisible to `nix eval`, `nix flake check`
  and the formatter, not only to builds. The error reads like a missing file, or worse, nothing fails
  because the file simply is not there.
- `nix flake update <parent> gen` re-locked the whole `gen` hub closure: about 1000 lines of lock churn and dozens
  of unrelated rev bumps that the reviewer reverted. A targeted bump was a 6-line diff.
- One library can appear as many lock nodes at different revs. In one `ci/flake.lock`, ten `gen-merge`
  nodes sat at three revs. A two-segment `--update-input parent/lib` moved one of ten, and not the
  one the fixture read. The regression witness then evaluated a library that never moved and reported
  green.

**How to apply:**

- `git add <specific files>` (never `-A` or `.`) after creating files, before any nix command.
- Testing a template against a local checkout: `--override-input <input> .`.
- For a transitive bump: trace the consumer's actual resolution path through the lock
  (`root -> a -> b -> lib`), bump that chain (`--update-input a/b/lib`), then verify the node you
  named is the one whose rev changed. Re-run every gate that reads it.
- Style: `inherit name;` instead of `"name" = name;` when the identifier is bound in scope.
- When a task touches a file that has grown many unrelated responsibilities, split it into coherent
  smaller files (standing permission). Do not over-split: no shared constants file for a handful of
  values; inline single-use logic.
- In an auto-importing module directory, a helper file that is not a module needs the directory's
  exclusion convention (for example a `_` prefix) or it gets imported as one.

Related: \[[pin-container-images-by-digest]\] \[[reading-test-suite-output]\]
