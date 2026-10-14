---
name: verify-substitutions-and-reformats
description: When checking that a sed/replace sweep, a correction or a formatter run did exactly what was intended
type: trap
---

**Rule:** Verify a substitution with three predicates: the old form is absent, the new form is present (anchored), and the over-applied form is absent, checked by name. Re-read bulk mechanical diffs with whitespace ignored.

**Why:**

- The correct new form is often a prefix of the over-applied form, so an unanchored grep for the new text passes on exactly the failure it exists to catch. Before any `sed`, ask what it does if it runs twice.
- Python `str.replace` fails silently on no match.
- When a correction convention keeps the withdrawn sentence verbatim inside the correction note, grepping for the old text hits at every revision, including the corrected one. Predicate on the NEW text.
- A markdown formatter upgrade re-padded tables across four repos. One 706-line commit contained one real content deletion: `Σ|reach|` became `Σ`. The unescaped pipes split the cell, and the formatter truncated the overflow instead of refusing. The agent read the diff by shape and called it "padding". `git show -w` cut 706 lines to 60, and the loss was among them.
- A mutation that does not apply looks exactly like a construction that survives it.
- A mutation proof binds to bytes, and a formatter moves bytes. Proofs run before formatting are about a file that never ships.

**How to apply:**

- `grep -rnoP 'new(?!\.)'` (anchored), plus a named check for the over-applied form. Print and read the hits; do not only count them.
- Assert each replacement pattern matched exactly once before writing.
- On a reformatting commit: `git show -w <rev> -- '<glob>'`. Use a before/after `grep -c` on the specific token to confirm.
- Repair by escaping (`Σ\|reach\|`), not by restoring. Confirm the fix holds with a second formatter pass that reports 0 changes.
- Confirm a mutation applied with `git diff --numstat`, and re-run mutation proofs against the committed bytes.

Related: \[[grep-wrapped-prose]\] \[[git-measurement-traps]\]
