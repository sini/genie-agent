---
name: nix-eval
description: How tier 1's eval tool behaves and how to read its result. Use before any eval call, and when a question asks why a Nix expression or flake fails to evaluate.
---

# nix-eval

`eval` evaluates one attribute of one repository at one rev, in a sandbox that starts empty. It
never builds. Use it when the answer depends on a value Nix computes: an option's final value, a
`drvPath`, or whether an expression evaluates at all.

## The request

- `repo` is a GitHub repository written `owner/name`. The runner refuses any other form before
  Nix runs.
- `attr` is a flake attribute, for example
  `nixosConfigurations.laptop.config.system.build.toplevel.drvPath`. The attribute `checks` runs
  `nix flake check --no-build` on the whole flake instead.
- `trusted` is `"no"` unless the thread is trusted and the eval needs import-from-derivation
  (IFD). It can only lower trust: `"yes"` on a public thread still runs untrusted.

Evals run one at a time per thread.

## What the sandbox refuses

The eval is pure: `builtins.getEnv`, `<nixpkgs>` lookups and paths outside the flake's inputs
fail. IFD is off unless the eval is trusted. Nothing builds, and the network reaches only GitHub
and the nixpkgs channel hosts. An error from one of these is a property of the sandbox, not of the
asker's configuration. Say which one it was before you blame their code.

## The result

`{exit, stdout_tail, stderr_tail, limit_hit}`. The tails are the last 4096 characters of each
stream. `limit_hit` is `none`, `oom`, `timeout`, `egress` or `unknown`. When it is not `none`, report the
limit that was hit as a finding, and add the unchecked claim to `gaps`.

## Secrets

When an agenix or sops secret blocks the eval, stub its path or substitute a placeholder value
in the attribute you evaluate. If that is not possible, say that a secret blocks the eval and what
the eval would have checked.

## What to cite

Name the repo, rev and attribute, the exit code, and the line of `stdout_tail` or `stderr_tail`
that carries the answer. If an eval reproduced an error you cannot explain, that is a hard trigger
in the `escalation` skill.

## Gaps in this skill

- How tier 1 learns a thread is trusted is not in this skill.
- An eval request carries only `repo`, `rev`, `attr` and `trusted`, so how a secret stub reaches
  the evaluated configuration is not settled.
- A trusted eval refused on a public thread becomes a pending action that a trusted person
  approves (plan C9). What tier 1 should say in that case is not settled here: describe the eval
  you would run and why, and list it in `gaps`.
