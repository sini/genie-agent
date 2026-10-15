---
name: nix-path-flake-ref-through-symlink
description: Applies to Nix probes that take a flake ref under a symlinked directory (e.g. a scratchpad link).
type: trap
verified: 2026-10-15; Nix 2.34.8, Determinate Nix 3.23.1, Lix 2.95.3
---

**Rule:** Any probe taking a flake ref must `readlink -f` its argument first.

**Why:** Measured, same flake, one run: `builtins.getFlake "path:$SP/x"` => exit 1,
`error: path '//tmp/sp-...' is a symlink` (note the doubled slash). The same flake at
`$(readlink -f "$SP")/x` => exit 0. The error is raised when the value is FORCED, so it surfaces inside
whatever attribute happened to force it and reads like a defect there; one agent lost a round
believing it had a `builtins.head` bug.
Scoped: `nix eval --file "$SP/probe.nix"` through the same symlink works (exit 0, correct value,
real-path control also exit 0). The refusal is specific to `path:` flake refs. Do not "fix" a working
`--file` probe.

**How to apply:**

```sh
ref="path:$(readlink -f "$SP")/flake-dir"
nix eval --impure --expr "(builtins.getFlake \"$ref\").outputs.x"
```

Related: \[[scratchpad-shared-across-agents]\]
