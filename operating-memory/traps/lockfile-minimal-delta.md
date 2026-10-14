---
name: lockfile-minimal-delta
description: When regenerating or bumping a lockfile (Cargo.lock, flake.lock) for a targeted change
type: trap
---

**Rule:** Update only the dependency you mean to change. Never regenerate a whole lockfile for a targeted bump.

**Why / measured:**

- `cargo generate-lockfile` for a one-crate bump also upgraded an unrelated transitive crate to a version needing a newer Rust edition, past the project's minimum supported Rust version, and CI failed. The fix was to restore the upstream lock and run `cargo update -p <crate>`, which left the unrelated crate unchanged.
- In Nix repos with nested flakes, subflake locks flatten transitive root pins. Bumping a root pin without the subflake locks leaves the two disagreeing (see \[[repo-has-more-than-one-lock]\]).

**How to apply:**

- Cargo: `cargo update -p <crate>`. Flakes: `nix flake update <input>` in every flake that pins it, in the same commit.
- Read the lockfile diff and confirm that only the intended nodes moved.

Related: \[[repo-has-more-than-one-lock]\] \[[nix-override-input-silently-inert]\]
