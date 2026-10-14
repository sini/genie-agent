---
name: br-output-row-shapes
description: Applies when grepping or counting br's native text output.
type: trap
---

**Rule:** Check the real row shape of br's output before writing a predicate, and prove the predicate
with a positive control on the same output.

**Why:** Measured silent failures:

- Result rows are prefixed with a STATUS GLYPH, so `grep -c '^<prefix>-'` (an id anchored at
  start-of-line) reads 0 over a full result set.
- `br list --search` is not a flag. It does not fail usefully; you get a wrong corpus.
- `br lint` exits 1 on success in the measured version, and counts from `count` and `list` can disagree.
- Comments are absent from `br list` payloads; a sweep over list output never sees comment text.

**How to apply:**

- Anchor on the id anywhere in the line (`grep -c '<prefix>-[a-z0-9]'`), never `^`.
- Use `br search <term>` or a scripted filter over `br list --all --limit 0` for text search, and sweep
  comments separately.
- For any rc you rely on, measure what success looks like once, and write it down.

Related: \[[br-native-text-for-models]\] \[[tracker-br-traps]\]
