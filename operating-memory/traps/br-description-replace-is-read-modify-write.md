---
name: br-description-replace-is-read-modify-write
description: Applies when appending a block to an existing bead/issue body with br.
type: trap
---

**Rule:** br has no append flag; `--description` and `--description-file` REPLACE the whole body. Treat
an append as read, append, write, verify, and refuse BEFORE the write if the read looks short. Never
answer a refused write with `--force`.

**Why:** The read is non-deterministic under load. Measured: a read of a 454-line body returned ONE line,
the literal string `null` (`.[0].description` over an empty result renders as `"null"`, which looks
like a one-line body). The append built a 68-line file. br's own guard refused it ("a write that clears
the field or keeps less than half its length needs --force"). The jq array-or-object guard did NOT catch
it, because the shape was not the problem; the identical read seconds later returned 454 lines. br's
length guard was the real backstop, so `--force` is exactly the flag that turns a bad read into a lost
body.

**How to apply:**

```sh
render_body <id> > pre.txt                       # your reviewed script
pl=$(wc -l < pre.txt)
if [ "$pl" -lt 50 ] || [ "$(head -1 pre.txt)" = "null" ]; then echo ABORT; exit 1; fi
pre_md5=$(md5sum < pre.txt)
cp pre.txt new.txt && cat block.md >> new.txt
br update <id> --description-file new.txt; echo "rc=$?"
render_body <id> | head -n "$pl" | md5sum         # MUST equal pre_md5
```

- Verify by md5 of the preserved PREFIX, never by line count (a truncated body plus a long block can
  have more lines than before).
- A refusal from br's length guard is a measurement: your read was short. Re-read; never force.
- Do not use a grep for the row's TITLE as a control: the title is a separate field, reads 0 against
  the body, and looks like a failed write when it is not.
- Better: wrap all of this in one script that refuses on empty payload, empty current body, or a
  read-back that is not byte-identical.

Related: \[[redirect-truncates-before-read]\] \[[tracker-br-traps]\]
