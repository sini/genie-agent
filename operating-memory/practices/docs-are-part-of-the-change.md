---
name: docs-are-part-of-the-change
description: When adding or changing API surface in a library, and when reviewing such a change
type: practice
---

**Rule:** Code plus tests is not a finished library change. Update the library README, the
canonical reference spec and any live docs site in the same landing. Cite the THEORY in code
comments, and mark truly novel constructions as novel.

**Why:**

- New API landed without docs and a separate agent had to be dispatched to fix two libraries.
- Owner: "we do have a standing preference to show our work as an implementation of peer
  reviewed theory. Where our work is truly novel, it requires explicit documentation."
- mdformat silently un-escapes `\|` to `|` inside inline code in tables, a 2-byte change that
  a local check from the wrong directory did not catch.

**How to apply:**

- Implemented theory carries a PRIMARY-verified citation (author, year, section, and which
  result it is), checked against the paper itself, not a name that merely sounds right.
- A novel construction carries an explicit note ("original to this library; no primary
  claimed"). A novelty claim is an absence claim, so state what was searched.
- Match the file's existing comment density and format.
- Reviews treat docs as a GATE: README and reference spec updated, formal rules stated
  VERBATIM, and the rules logically sound against the existing ones.
- Verify markdown the way CI does: run the CI flake's formatter from the directory CI uses.
- A dispatch that names doc sites names all of them, including the docs site.
- While an API is still growing across sub-plans, the README and reference spec may wait for
  one docs pass over the stable surface. Citations in comments may not wait.
- Adding missing citations is its own pass. A conformance checker classifies citations; it
  does not add them.

Related: \[[code-comments-cite-invariants]\] \[[design-bar-theory-not-compat]\] \[[format-before-commit]\]
