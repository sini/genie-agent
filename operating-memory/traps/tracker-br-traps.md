---
name: tracker-br-traps
description: When wiring dependencies in beads/br, when br reports 'database is busy', or when a br read returns an empty result under concurrent agents
type: trap
---

**Rule:** `br dep add X Y` means X depends on Y. A br zero is not an absence unless its exit status was
0 AND a positive control fired in the SAME invocation. When br reports busy, run `pgrep -ax br` (exact name
match; a substring match also hits unrelated processes such as `dbus-broker`) before doing anything
else: a live process means wait, no process means a genuine wedge.

**Why / measured:**

- Dependency direction was inverted twice in one day when wiring rows as blockers of a gate. An
  inverted edge is silent: the row shows no differently in `br ready`, and the gate simply stops
  counting it.
- Under a 12-agent fleet, a body-render script built on br emitted one JSON warning line (`database is busy` / a sync-merge warning) and exited rc 2. Every grep over that output read 0, INCLUDING the
  positive control, because the control went through the same broken read. Attempts 1 and 2: rc=2,
  0 lines; attempt 3: rc=0, 3496 lines. `br search` does the same: clean empty stdout, `database is busy` on stderr. A gate's whole sweep read 0 while a foreground re-run of the same loop read 28.
- `database is busy (recovery in progress)` has two causes with the same text:
  - A live `br` holding the lease is transient contention. Wait. Killing a `br search` hands its caller
    an empty result that reads as a clean "no prior art" sweep.
  - No process at all means engine state in the DB file family is wedged.
- `br doctor` reports healthy at rc 0 in both cases. `br doctor --repair` fails closed on the very check
  the wedge blocks, and a passing `--dry-run` never reaches that gate.
- The JSONL export carries comments, labels and dependencies nested per issue. A check that tests only
  line 1 for `has("comments")` is a broken predicate.
- (Older bd) some link types were never exported. State any relationship you care about in the body
  text as well, because the body always survives.

**How to apply:**

- After every gate wiring: `br dep list <gate> | grep -c <row>` must be 1, and
  `br dep list <row> | grep -c <gate>` must be 0.
- `br ... > out 2> err; echo $?` and look at both. rc 2 means the READ failed. Retry a few times with a
  short wait before accepting an empty result.
- Under contention, read the tracked JSONL export instead of the DB:
  `jq -r 'select(.id=="<id>") | .description' .beads/issues.jsonl`. br refuses concurrent writes
  rather than corrupting, so the export is coherent.
- For a genuine wedge: back up `.beads/`, move (do not delete) the DB family into a quarantine
  directory, and run `br sync --import-only` to rebuild in place from the untouched `issues.jsonl`.
  Check the jsonl md5 before and after.
- Compare per-table counts (issues, comments, labels, dependencies) via read-only `sqlite3` against
  counts from the JSONL, before and after. SQLite reads keep working while br is down.
- br writes through to the JSONL but never runs git. Commit `.beads/` with your change.

Related: \[[controls-for-absence-claims]\] \[[br-output-row-shapes]\] \[[br-description-replace-is-read-modify-write]\] \[[json-accessor-envelope]\]
