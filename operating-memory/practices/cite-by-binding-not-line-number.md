---
name: cite-by-binding-not-line-number
description: When citing a location in code or a document in a brief, report, register or tracker body that others will re-read later
type: practice
---

**Rule:** Cite by binding name or verbatim expression (`global.nix:coScc`, "the `repCycle`
binding"), never by a bare line number. A line number is admissible only as the output of a
stated command at a stated revision (`git grep -n <expr> <rev> -- <path>`).

**Why:**

- Three briefs in one day carried line numbers that were already, or immediately, wrong. One
  quoted line was ten lines off, then an unrelated edit shifted it by ten and made it
  accidentally correct, and nobody checked either state.
- A census across 113 commits: binding-name and verbatim-expression anchors showed zero decay,
  while line ranges decayed four times over. Across six gate rounds, every line-citation
  finding was a hand-typing error.
- One routing reference read `:111`, then `:177`, then `:181` in a single day, because its
  body was appended to twice.
- A coordinate read off a `sed -n 'a,bp'` window is arithmetic, not measurement: that window
  prints no line numbers. Use `grep -n` or `cat -n`.

**How to apply:**

- In dispatches, write the binding name and add "re-verify the anchor; my citation is from an
  earlier revision".
- A string anchor and an executable probe test different things: anchors test that text is
  written, probes test that it is true. A claim that "X is written AND X is true" needs one of
  each.
- Code-index graphs (call graphs, symbol indexes) are not a citation substrate. They are not
  pinned to a revision, depend on index freshness, and are unsafe for absence claims. Use them
  to scout; cite with rev-pinned commands.
- Pin an uncommitted artefact by digest plus line count (`md5sum`, `wc -l`) at the moment you
  cite it. A table inside the artefact outranks any prose restatement of it, including yours.

Related: \[[relayed-is-not-measured]\] \[[brief-premises-are-hypotheses]\]
