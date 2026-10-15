---
name: armed-controls
description: Before believing any zero, absence, "no change", or green from a sweep, grep, census or test, and when choosing the control that is supposed to validate it — the laws for a control that actually measures
type: practice
---

**Rule:** A census PROVES EXISTENCE when it hits; a zero confirms nothing. Report it as "zero over
<population> at <revisions>", not "absent", and draw no decision from it. A clean result is evidence
only with an armed instrument: a live control from the same instrument in the same run, whose domain
reaches past the predicate's, taken at an operating point where the defect would be visible; and every
green is shown to go red when you seed the thing it should catch.

**Why (each law was paid for by a false green):**

- The owner withdrew a relayed "this does not reopen" that rested on a zero census with live controls:
  "a census only proves existence, absence confirms nothing". A firing control proves the predicate
  works where it looked, not that the object could not live elsewhere: a sentence "did not exist"
  across `*.md`; it was in tracker bodies no file glob reaches.
- **Picking a control is a measurement.** A docs-only landing filter read 0 on the subject and 0 on the
  control, because the control commit was also docs-only. A commit the filter could catch (115 lines)
  armed it.
- **Regime.** A laptop shed 36 °C in four minutes idle, so the cooling path was declared healthy. The
  defect was a degraded thermal interface, roughly constant in °C/W: ~10 W idle cost 20 °C, 28 W load
  cost 55 °C and pinned the CPU. Every figure true; the control taken where the defect is invisible.
- Main and control needles were two hand-copied literals: breaking the control went red, breaking the
  MAIN read green over a real defect.
- A file list's last row was unterminated; a shell `read` loop dropped it: 21 of 22 files scanned,
  exit 0.
- Grepping nixpkgs' word (`emptyValue`) over gen-merge (a re-implementation of the nixpkgs module
  system) found nothing; gen-merge uses `whenEmpty`. The one hit was a comment listing "the foreign
  protocol's words".
- A line grep and a whitespace-flattened grep both read 0 ("two methods agree"); the phrase was present,
  the continuation line's `#` left inside it. Other misses in one day: the file a row cites rather than
  the one the construct lives in; `x.y` searched where source reads `inherit (x) y`.
- `git merge-base --is-ancestor <fabricated-sha> <ref>` returns 128 (never ran), not 1 (said no). A
  negative-control token fired because an earlier sweep had written it into the corpus.

**How to apply:**

01. State the domain on both sides. Narrower gives false greens; wider gives false reds.
02. Every absence: a control known to fire IN THAT FILE, same instrument, same run. A control reading 0
    means the predicate is broken, not that the thing is absent.
03. Arm a pair on the same bound operand; the control exercises it at an input the main arm does not.
    Test by breaking the MAIN arm. Stock and mutated arms reading the same means nothing was measured.
04. Reach claims: one control outside the claimed domain, plus a per-member "files scanned" count;
    assert scanned == expected. A list also needs a POPULATION control: a truncated listing (default
    limit, closed items excluded) cannot be saved by a predicate control.
05. Seed, confirm red, remove. A control pointed at something known clean can only agree. Name the
    seeding axis used (mutate the guard vs vary the fixture) and the one not used.
06. Operating point: before citing a measurement as clearing a defect, ask whether the defect is visible
    there. For constant-coefficient losses (°C/W, per-operation overhead), control under load.
07. Enumerate forms; report spellings covered and evasions unswept. Strip comment markers, then flatten.
    For a re-implementation, take search terms from the subject, not from what it re-implements.
08. Fresh nonsense token per sweep; a real non-ancestor commit as the ancestry control.
09. Correcting a predicate: re-derive its population from the original universe, not the prior output.
10. Brief a census as hit list, population and revisions; keep any trigger the zero would disarm ARMED.
11. Two correct measurements on different axes can compose into a wrong action; the axis travels with
    the claim.

- Scope: these laws govern MEASUREMENT, where a command can refute the claim. Where none exists,
  acceptance is a named person's judgement; do not invent a proxy metric.

Related: \[[success-signal-is-not-measurement]\] \[[counts-need-anchor-and-population]\] \[[conclusion-and-basis-are-two-findings]\] \[[relayed-is-not-measured]\] \[[reading-test-suite-output]\]
