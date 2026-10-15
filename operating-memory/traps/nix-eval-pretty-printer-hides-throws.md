---
name: nix-eval-pretty-printer-hides-throws
description: Applies to probes asking "does this throw / refuse / is it tryEval-catchable".
type: trap
verified: 2026-10-15; Nix 2.34.8, Determinate Nix 3.23.1, Lix 2.95.3
---

**Rule:** Drive catchability and refusal probes with `nix eval --json` and read the exit status
unpiped. Check that a boolean conjunction actually reaches the site under test.

**Why:** Two false starts in a row on one question:

1. A probe routed through `a && b` short-circuited before the crash site; the error never fired and the
   arm read clean.
2. A direct probe read rc 0 because `nix eval`'s default pretty-printer swallowed the error inside a
   nested value and printed a display placeholder. Re-run with `--json`: rc 1, the true answer.

**How to apply:**

```sh
nix eval --json --impure --expr '<probe>' > out 2> err; echo "rc=$?"
```

- For each conjunction, confirm the left side is true on your input.
- Pass lib explicitly when outside a flake (no channels on many hosts):
  `--expr 'let lib = (builtins.getFlake "nixpkgs").lib; in ...'` or `-I nixpkgs=flake:nixpkgs`.

Related: \[[nix-force-to-prove-supplied]\] \[[read-exit-status-unpiped]\]
