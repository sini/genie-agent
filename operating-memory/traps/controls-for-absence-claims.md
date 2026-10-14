---
name: controls-for-absence-claims
description: When reporting a zero, an absence or an "identical" result, and building the positive/negative controls that make it meaningful
type: trap
---

**Rule:** Every absence claim carries a positive control that runs YOUR predicate, in the same
instrument, same output form, same run and comparable complexity, on a case known to match. If the
control reads 0 too, the instrument is broken: fix it before reporting anything. Plant a positive if
the material has none, and mint fresh negative tokens each run.

**Why / measured:**

- Sweeps where every term AND the control read 0, each looking like a clean, well-controlled absence:
  zsh did not word-split an unquoted `$list`, so grep got one concatenated path; `git grep -lin` parsed
  as `--lin` and printed nothing to stdout; a tracker read failed with "database is busy" (rc 2) and
  produced empty output. The control is what exposed the first one.
- A sweep for pattern P was "controlled" by pattern Q firing 5 times. Both figures were true and the
  pairing proved nothing about P.
- P run against the very revision that "carried" the offending text returned 0, because the text had
  only ever existed in a report. When the corpus holds no known positive, a planted case is mandatory.
  Say that it was planted.
- Negative-control tokens get copied into reports and tracker bodies. A reused token later fires on the
  record of an earlier run and looks like a broken instrument. The opposite hazard follows: dismissing
  a genuine hit as "just a banked token".
- A control slug written into the file being swept makes the "MISSING" probe match the file's own
  documentation. The armed run then looks identical to a clean pass.
- A comparison instrument needs its own negative control. A nonexistent arm must report UNUSABLE, never
  IDENTICAL. The comparator can be dead while both subjects are fine.
- An id predicate also matches inside other records' text. Anchor it to the id field
  (`cut -f1 | grep -cx id`).
- In an aborting run no control can fire, because the abort destroys the output. The strongest form
  available is the same file and expressions at a size that returns. Say so explicitly.

**How to apply:**

- Write the subject and the control in the same command, with the same flags, and print both values.
- Read exit status unpiped and look at stderr: `cmd > out 2> err; echo $?`.
- Report counts per term INCLUDING zeros, and make a sweep script refuse (exit 1) when every term is
  zero.
- Generate a new random token for each negative control and never commit it.

Related: \[[control-population-must-match-claim]\] \[[control-must-differ-on-the-failing-axis]\] \[[read-exit-status-unpiped]\] \[[grep-wrapper-and-count-units]\]
