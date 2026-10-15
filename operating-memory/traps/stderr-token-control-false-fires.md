---
name: stderr-token-control-false-fires
description: Applies to probe harnesses that detect success/failure by grepping nix stderr for a marker.
type: trap
verified: 2026-10-15; Nix 2.34.8, Determinate Nix 3.23.1, Lix 2.95.3
---

**Rule:** Do not detect a control token by grepping stderr alone. Check the run parsed and evaluated
(exit status, a structured output) before reading the token.

**Why:** On an error, nix quotes the source line around the error position, and with `--expr` that line
is your expression, which CONTAINS the control token. A run that merely failed to parse reads as the
token having fired, so a green from such a harness is not trustworthy on a run that did not parse.
The same mechanism makes any marker written in source text (a comment containing the failure glyph,
a token string) leak into traces.

**How to apply:**

- Emit the token as a VALUE (`--json` output on stdout) and check stdout, not stderr.
- Gate on rc first: a parse error must red the harness, not satisfy it.
- Pick tokens that do not appear literally in the expression (construct them, e.g. by concatenation).

Related: \[[nix-unit-collection-traps]\] \[[nix-eval-pretty-printer-hides-throws]\]
