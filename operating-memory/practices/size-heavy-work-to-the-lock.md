---
name: size-heavy-work-to-the-lock
description: When dispatching several agents that each need heavy evaluations (dependents runs, census, benchmarks) on one host guarded by a shared heavy-run lock
type: practice
scope: local
values:
  heavy-lock-slots: owner-set 2026-10-19
  per-run-memory-cap: provisional
---

**Rule:** Above a shared heavy-run lock, extra lanes add no throughput. Size heavy dispatch to the
lock's slots, fill the other lanes with light work, and have agents take the lock once per phase
through the shared wrapper, never per command and never a private lock. Changing the slot count is
the owner's call.

**Why:**

- The host's heavy lock (a guard against a filesystem writeback deadlock) admitted one holder at a
  time. With six agents each needing a census plus a dependents run, seven waiters queued. One spec
  ran 7.5 hours for about 50k tokens of progress, nearly all of it waiting. The owner noticed first
  ("is the lock stalled?").
- The owner raised the lock to two slots (two is the memory bound: each run is capped at 12G), then
  moved it back to one by default after the deadlock recurred under two heavy holders, with two as an
  opt-in.
- In a stacked queue on one repository, the last unit pays for every predecessor: each landing ahead
  of it restarts its dependents run.

**How to apply:**

- Count heavy units in flight against the slot count before each dispatch. Light work for the other
  lanes: specs before their census, gates without a census or dependents run, scouts.
- Brief: "run heavy commands through the lock wrapper, once per phase".
- Do not raise the slot count yourself; it relaxes a safety guard.

Related: \[[concurrency-budget]\] \[[cap-every-heavy-evaluation]\]
