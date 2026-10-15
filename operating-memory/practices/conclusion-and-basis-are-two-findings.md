---
name: conclusion-and-basis-are-two-findings
description: When accepting a claim with a stated rationale, or asserting a causal chain ("A forces B forces C") from code you have read
type: practice
---

**Rule:** A claim's conclusion and its stated basis are two separate findings; verify both.
Grep proves a construct EXISTS. It cannot prove that execution REACHES it.

**Why:** both directions fail.

- **True conclusion, false basis.** In one session: a gate accepted a change whose recorded
  reasoning contained a false clause (an environment variable assumed to hold the flake's
  location held the shell's working directory instead). A standing rule was grounded on "the
  wrong accessor reads empty", when measurement showed a wrong envelope errors loudly (jq exit
  5\) and a missing field is the silent case (`null` at exit 0). A script comment gave that same
  false premise. Each conclusion held, so nothing failed until someone reasoned forward from
  the mechanism, and then the failure appeared somewhere else and did not point back.
- **Every coordinate verified, the chain false.** Three bindings were read at source, each
  exactly where claimed, and a causal chain was inferred through them and recorded twice. The
  failing path actually ran through a different reader of the same list: the right operand of
  an `||`, reached with the guard never in the path. Because each coordinate checked out on
  re-read, reviewers cleared the claim and it went onto a "do not re-derive" list. It was
  caught only when someone had to walk the real path for an unrelated reason.

**How to apply:**

- On accepting anything, ask two questions separately: is the conclusion right, and is the
  reason given right? Only the second is load-bearing for whoever extends it.
- The tell: a rationale that has never been reasoned forward from. Ask what would be built ON
  this reason.
- When you find one, write "the conclusion survives; its stated basis does not", then replace
  the basis. Do not silently keep the conclusion.
- For "A forces B forces C", drive the path: `nix eval --show-trace` and read the frames, run
  a two-arm probe, or seed a throw at the site.
- Distrust a chain assembled from separately verified parts. `||`, `&&` and guards are where
  chains fork. Enumerate a binding's readers before asserting which one fires.
- When a chain breaks, say "correct measurement, wrong domain".
- Amending law or standing instructions on this basis is an owner act: file the measurement
  and the proposed wording.

Related: \[[armed-controls]\] \[[relayed-is-not-measured]\]
