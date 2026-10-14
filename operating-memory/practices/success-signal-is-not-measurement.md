---
name: success-signal-is-not-measurement
description: After any edit, formatter run, script, commit, or check that "passed" — before claiming the change landed or the check is meaningful.
type: practice
---

**Rule:** A tool reporting success is a claim about an artefact, not a measurement of it. Verify the
artefact itself: diff it, re-read it, evaluate it. Before trusting a green, ask what a failing run
would have looked like; if the answer is "the same", you measured nothing.

**Why (each landed, none caught by reading the tool's output):**

- A commit titled "apply the repo formatter" applied the formatter's INVERSE and left two repos red. A
  stale pre-commit hook's output was read as the formatter's.
- An edit script printed `fixed <file>` while applying zero edits: its guard tested a phrase absent
  from the file. Caught only by diffing against a backup.
- A commit message claimed a fix that was never performed.
- An oracle whose red arms all fired correctly had a broken GREEN path (it shadowed `$out` with a grep
  capture). It would have landed broken and then passed nothing forever.
- A verification took "gen-schema's `refined` loses nothing" from the build's own commit message and
  reported it as evidence. It was false: `refined` lost its functor name.
- `nix flake check` printed "running 0 flake checks / all checks passed!" at exit 0; the banner is a
  cosmetic tail and proves nothing in either direction. A propagation run meant to make a check live
  was about to exit on "all CI runs green", which is compatible with achieving nothing.
- A regex over flake inputs read 56 of 59 edges and printed a summary byte-identical to the correct
  one; attrset-form inputs were invisible to it.

**How to apply:**

- After any edit batch: `git diff` / `git status`. A file absent from the diff was not edited.
- After a formatter or generator: re-run the authoritative gate, not the hook in front of it.
- Before writing a commit message or report: check each clause landed.
- Scripts with hardcoded anchors assert their match and fail loudly when it is missing.
- Exercise BOTH arms of every oracle. The tell: you have watched it fail six ways and never watched it
  pass on an unmodified tree.
- The artefact under review is never a source for its own verification. Tell: your verification and
  the artefact share a sentence.
- Derive by EVALUATION (`nix eval ... --apply builtins.attrNames`, walk the lock), not by parsing
  text a program also prints. State the path you followed.
- Two readings agreeing is corroboration only if they used different paths.
- A correction is itself a secondary and reads as more reliable than what it corrects. Give it the same
  primary check.

Related: \[[relayed-is-not-measured]\] \[[armed-controls]\] \[[reading-test-suite-output]\]
