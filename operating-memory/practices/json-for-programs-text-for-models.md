---
name: json-for-programs-text-for-models
description: When choosing the output format of a command or script whose output an agent will read.
type: practice
---

**Rule:** The consumer picks the format. A program consumes JSON. A model consumes text or markdown.
Put the JSON-to-text boundary inside the script.

**Why:** Models find structure in prose without field delimiters. JSON in the agent loop pays twice:
the syntax is dead tokens, and it is the shape a context compressor rewrites most aggressively, so it
is both the most wasteful and the most likely to be silently altered. Dumping JSON to disk and reading
it back avoids the compressor but keeps the waste.

**How to apply:**

- Shape: `cmd --json | jq -r '<text template>'`. Structured in, rendered out; the model reads the
  render and never sees a brace. Example: an issue-tracker "show" command piped to jq that emits
  the issue as markdown.
- When a payload is large because it is a corpus (a whole-tracker prior-art sweep), filter in the
  script too: pass search terms in, get matching records rendered out. Do not hand the model the
  corpus to grep mentally.
- Count in the script as well as filter, so the figure is not taken from a truncated display.
- Dump-to-disk is still right for verbatim-critical text (issue bodies, quotes, anchors) where the
  bytes are the artefact. That is a different problem from format choice.
- Model-facing listing commands should be the native text forms (for example `br list`, `br ready --limit 0`); keep `--json` for scripts.

Related: \[[counts-need-anchor-and-population]\]
