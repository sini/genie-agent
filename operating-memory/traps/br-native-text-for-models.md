---
name: br-native-text-for-models
description: Applies whenever an agent reads the beads/br tracker, or writes a jq predicate over its JSON.
type: trap
---

**Rule:** A command whose reader is the MODEL gets br's native text (`br ready --limit 0`, `br list ...`,
`br comments <id>`). `--json` plus `jq` belongs only inside a script that a human reviewed once.

**Why:** br's JSON commands return three DIFFERENT envelopes: `list` returns `{issues: [...]}`, `ready`
returns a bare array, `show` returns an array. A wrong accessor fails three ways, and only one is loud:

- chained to a field (`.[].id` on `list`): exit 5, empty stdout. Loud, fine.
- bare `.[]` on `list`'s object: emits the issues array PLUS stray scalars, exit 0, empty stderr. The
  output opens with `[` / `{` / `"id":` and looks exactly like the right answer.
- a field the envelope lacks (`.dependents` on `list`): reads `null` at exit 0.
  The silent-and-plausible middle case is the dangerous one. Empty output gets noticed; plausible output
  does not. The token argument is weak: hand-rendered `--json | jq -r` text was measured about 5% smaller
  than native text. The real ground is that native text has no envelope to get wrong.

**How to apply:**

- Model-facing reads: native text, no `--json`.
- Do NOT read a bead body with bare `br show`: it was measured at 48x the size of a scripted body
  render (389 KB vs 8 KB) and drags in all comment history. Use a small reviewed script that renders the
  description field only.
- Script-facing reads: guard the shape explicitly, e.g.
  `jq -r 'if type=="array" then .[0] else . end | .description'`.
- Before writing any predicate over native output, check the row shape (see \[[br-output-row-shapes]\]).

Related: \[[br-description-replace-is-read-modify-write]\] \[[br-output-row-shapes]\]
