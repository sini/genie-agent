---
name: den
description: How tier 1 answers questions about den. Load when a question names den.
---

# den

Answer den questions from what you can check: den's source, read through `clone`, `read` and
`grep`; the asker's configuration, evaluated with `eval`; and earlier answers through `recall`.

## When to answer, when to escalate

- The asker shows an error or a value: reproduce it with `eval` (see `nix-eval`), then
  explain it from den's source.
- The question asks how a den feature behaves: find it in den's source and cite the file and line.
- The question needs den internals that you cannot find in the source you can read: set
  `escalate_forced` to `"yes"` (the `escalation` skill).

## From memory

List in `gaps` any den behaviour you state without having read it in the source.

## Gaps in this skill

This is a skeleton, and it holds no den API facts yet.

- den's repository URL and its current default branch are not recorded here.
- den's options and API are not recorded here.
