---
name: pdf-text-extraction-traps
description: When grepping or quoting text extracted from PDFs (papers, specs), or verifying that an archived paper is the one its filename claims
type: trap
---

**Rule:** Text extracted from a PDF is a lossy instrument. Grep stems with `-a`, test ligature variants, never quote a formula from the extract, and verify a paper's identity by its title page and md5, never by its filename.

**Why / measured:**

- A file named for one 1999 paper actually held a different 2003 paper. Every sweep that looked for the first paper by filename returned PRESENT: a missing primary wearing a present filename passes every filename-based check. An archive-wide audit later found it was the only hard mismatch in 149 files; the failure mode is what matters, not the count.
- Ligatures fail three ways: `fi` extracted as a space (`de ned`), kept as U+FB01 `ﬁ` (an ASCII grep for `stratif` reads 0), or `ffi` as a raw 0x0E control byte. Several modes can coexist in one file. One paper spelled `fi` as `=`. Another was letter-spaced, losing about 41% of matches. A count of 0 for a word like `define` is a tell of corruption, not a finding.
- `pdftotext -layout` keeps end-of-line hyphenation. Any long term can vanish depending on where the typesetter broke the line. Plain `pdftotext` rejoins hyphens.
- The recorded alternation `De(f|ﬁ)nition` was misspelled: its ASCII arm reads "Defnition". It returned 0 on ASCII files and fired on ligature files, so it looked like a working instrument. The correct form is `De(fi|ﬁ)nition`, proven on a two-spelling control.
- Bitmap-font (Type 3) papers have no text layer. The OCR substitute silently rewrites logic: rule arrows dropped, math leaking into ASCII. A rule that has lost its head still reads as a well-formed rule.
- An OCR text layer rendered `j ≤ i` as `j < i` on exactly the page a grep lands on.
- Extracts trip grep's binary heuristic. Use `-a`, or every predicate reads 0 at once.
- `file` reports PDF page counts from an intermediate node. Use `pdfinfo`.

**How to apply:**

- Compare the first page's title/author/year to the filename.
- Grep a short stem that avoids `fi`/`fl`, use `-a`, and run a control in the same output form, ideally a word with no ligature.
- Check one common letter's frequency to catch a conversion that lost a letter globally.
- Verify every formula, rule or operator against the PDF page, and say so in the citation.
- Before archiving, `md5sum` the candidate against every held file and check the rendered title block.
- Summaries are not sources: they may orient, but never carry a citation.

Related: \[[controls-for-absence-claims]\] \[[grep-wrapped-prose]\] \[[cite-the-primary-honestly]\]
