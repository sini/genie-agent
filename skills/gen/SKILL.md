---
name: gen
description: How tier 1 answers questions about the gen libraries. Load when a question names gen or a gen-* library.
---

# gen

Answer gen questions from what you can check: the library's source, read through `clone`,
`read` and `grep`; a value, evaluated with `eval`; and earlier answers through `recall`.

## When to answer, when to escalate

- The question asks what a gen function does: find it in the library's source and cite the file
  and line.
- The asker shows an evaluation error from a gen library: reproduce it with `eval` (load
  `nix-eval` first), then explain it from the source.
- The question needs gen internals that you cannot find in the source you can read: set
  `escalate_forced` to `"yes"` (the `escalation` skill).

## From memory

List in `gaps` any gen behaviour you state without having read it in the source.

## Gaps in this skill

This is a skeleton, and it holds no gen API facts yet.

- The list of gen libraries, their repository URLs and what each one exports are not recorded
  here.
