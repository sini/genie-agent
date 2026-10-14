---
name: nix-force-to-prove-supplied
description: Applies when checking whether a module/harness supplies an argument, or a lazy value exists.
type: trap
---

**Rule:** Prove a value exists by forcing it (`builtins.seq x 1` in a test). Declaring it proves only
that the name is writable.

**Why:** Adding an unused formal `zzNotSupplied,` to a test file's argument list gave rc 0, 272/272.
Module args resolve lazily through `config._module.args.<name>`, so an unforced formal is a thunk
nobody evaluates. Adding one cell `expr = builtins.seq zzNotSupplied 1;` gave rc 1, 272/273,
"attribute 'zzNotSupplied' missing". Corollary: a module's formal list is not its scope; a module ending
in `...` has whatever the harness supplies. Reading formals produced a wrong correction once (an arg
believed missing that sibling suites already used).

**How to apply:**

- Probe a candidate arg with a cell that forces it; expect rc 1 if absent.
- Run the probe at least once where you know the answer, to prove it discriminates.

Related: \[[nix-eval-pretty-printer-hides-throws]\]
