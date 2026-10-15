---
name: large-files-read-in-slices
description: Applies when an agent must work with markdown/spec files over ~25K tokens, or with large diffs.
type: trap
verified: unverified
values:
  script-above-sites: provisional
---

**Rule:** Build a heading index once per session, then read by offset/limit. Never read a large spec or
a large diff artifact whole. Re-read only ranges you yourself edited.

**Why:** A 4,500-line (~580 KB) spec cannot be read in one call (the read tool refuses over its token
cap), and 195 partial re-reads in one session burned about 668K tokens. A `git diff` of such specs is
30-45K tokens and hits the same cap.

**How to apply:**

```sh
grep -n '^#\{1,4\} ' spec.md > "$SP/index.txt"
awk 'NR>=a && NR<=b' a=1200 b=1320 spec.md
split -l 400 big.diff "$SP/diff-part-"
```

- For a round touching more than ~5 sites in one big file, write ONE script that applies all
  replacements and asserts each matched exactly once, instead of many single-site edits whose anchors
  go stale. Verify with `git diff -U0` and `md5sum`.

Related: \[[harness-elision-is-not-a-population]\]
