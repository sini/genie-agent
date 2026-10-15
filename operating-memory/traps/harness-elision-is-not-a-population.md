---
name: harness-elision-is-not-a-population
description: When counting from tool output that may be elided, truncated or compressed (harness back-references, a context-compression proxy, your own head/slice)
type: trap
verified: unverified
---

**Rule:** Never count from a tool result carrying an elision marker, truncation or compression. Compute
counts in the shell (`| wc -l`) or write output to a file and count the file. If a compression layer is
in the path, verify by probe that novel output arrives intact, and fall back to dump-to-file plus sliced
reads when a tell appears.

**Why / measured:**

- A `git grep -l` listing four importers came back with three lines replaced by a back-reference like
  `[3 lines same as msg 14]`, so the surface read as ONE importer instead of four. The agent caught it
  only because it held an unelided earlier run. Elided output looks like terse output, not truncated
  output, and every downstream figure inherits the short count. The same holds for any `head`/slice you
  add yourself.

- Before tuning, a compression proxy replaced large tool results with lossy renderings: 219 of 319
  requests were compressed and about 960K tokens removed. Tracker bodies, owner quotes, md5/span
  anchors and count tables broke; JSON was the most-affected target. After tuning it became lossless,
  verified by sending a 40-line never-seen probe that came back byte-intact. Repeats then became
  explicit "same as message N" references, which preserve content but still shrink a visible listing.

- A CLI wrote its rows to stdout and its truncation notice ("Showing 3 of 153") to stderr, so
  `cmd --limit 3 > file` produced a short file with no notice in it. Ask for the full population
  (an unbounded limit) or capture both streams and check for the notice.

**Tells that compression has turned lossy:**

- elisions in the middle of a line, merged rows, dropped words
- `hash=` or `<<ccr:...>>`-style markers
- output shorter than its own stated cardinality (for example "40 rows" with 31 shown)

**How to apply:**

```sh
cmd > "$SP/<task>-out.txt"; wc -l < "$SP/<task>-out.txt"
```

- Read the file in slices if you need the content; get the count from the shell.
- Accept a "lossless" claim only from a probe with novel bulk content, never from testimony.
- On a tell, recover the originals with the proxy's retrieve tool if it has one, and use dump-to-file
  plus `Read` for verbatim-critical reads until the config is fixed.

Supersedes the general half of br-truncation-notice-on-stderr (retired with the tracker-specific traps).

Related: \[[large-files-read-in-slices]\] \[[nix-unit-collection-traps]\]
