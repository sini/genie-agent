---
name: nixos-module-conventions
description: When writing modules in a personal or fleet NixOS/home-manager configuration repository with established conventions
type: practice
---

**Rule:** Internalise the repository's idioms from its existing exemplars before writing. Do
not invent structure. Owner: "if I have to give you explicit instructions I may as well make
the modifications myself."

**Why:** a set of modules that ignored the project's conventions was tech debt the owner had to
clean up. Each convention below was learned from a correction or a breakage.

**How to apply:**

- **One concern per file.** Split a multi-facet feature (daemon and firewall / its secret /
  platform-specific parts), and open each file with a 1–2 line header naming its concern. Never
  a kitchen-sink file mixing home, system and secrets.
- **Presence is a role decision, not an `enable` toggle.** To turn a feature off fleet-wide,
  remove it from the role's includes. Settings parameterise the behaviour of an included
  feature; they never gate whether it exists.
- **Paths come from schema fields, never hand-built.** Anything forced during the BASE flake
  evaluation (schema and registry option defaults) must not reference `self`: registry → `self`
  → flake outputs → registry recurses infinitely. Use a path literal such as `rootPath = ../..`
  there.
- **Runtime files on REMOTE hosts must be real store-path dependencies.**
  `toString (rootPath + "/x.crt")` makes the whole flake source the dependency, which a remote
  deploy tool did not copy, so it worked only on the build host. Use
  `"${builtins.path { path = …; name = "x.crt"; }}"`.
- **Centralise generators and policies in their designated files**, and wire them through the
  documented include points. Fix a missing import; do not inline a copy.
- **Per-user content that needs a system resource** is a user-scoped module with a per-class
  branch, not a host-scoped loop over users.
- **Emit into the collector pools** (persistence, cache) that the repository provides, rather
  than writing the final option directly.
- **Locality over indirection.** Do not create a shared constants or `_lib.nix` file for a
  handful of values. A trivial one-line expression repeated at a few sites beats a helper file.
  The legitimate shared abstraction is a schema field.
- Format with the repository's `nix fmt <files>` (\[[format-before-commit]\]).

Related: \[[format-before-commit]\] \[[by-construction-over-repair]\]
