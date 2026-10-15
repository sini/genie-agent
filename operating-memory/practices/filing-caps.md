---
name: filing-caps
description: When deciding whether to file a tracker item, write a report, split oracles, or route an owner ask
type: practice
scope: local
values:
  reports-per-landing: owner-set 2026-09-16
---

**Rule:** File a tracker item only for a COMPONENT or a RULING. Write one report per landing.
Batch owner readings into one periodic sitting. Every owner ask gets a tracker row the day it
is made, wired to what it gates.

**Why:** over eight days, the framework route landed (7 of 8 items, bar blockers down from 54
to 6), while the backlog stayed flat (155 filed / 152 closed), report files doubled to 78 a
day, and the planning map grew to 3,649 lines and needed agents just to read it. Separately, an
early owner ask (visualisation tooling) never became a row, so a query-derived frontier could
never surface it. An ask with no row vanishes.

**How to apply:**

- Before filing, ask "component or ruling?" Docs counts, prose sites, citation anchors, README
  drift and stale comments are fixed in the landing that finds them: no ticket, no report, no
  handoff line.
- **Value/guarantee split.** A spec's oracles split into a GATING oracle (the mechanism driven
  red and read, plus the consumer's evaluation green), which ships with the landing, and the
  GUARANTEE (property cells, planted violations, censuses, enforcers), which is filed as one
  deferred row per component and re-armed once the consumer proves the value. Builders land
  value only.
- **One unit, one session:** a unit lands in one dispatch with its integration arm green, or
  it is split. It is not carried over.
- A user-facing surface exits on the OWNER having run it, not on agents' green.
- Readings that wait for the sitting take the recommendation meanwhile, marked "defaulted,
  reversible".
- **A row truly blocked on the owner is WIRED, not narrated:** give it a `blocks` edge to the
  single open sitting row, and remove the edge in the act that banks the ruling. Then the ready
  list shows only agent-actionable work. At a sitting's close, re-link only what was
  intentionally deferred.
- After banking an ask, RUN the query that derives the agenda and confirm the row appears
  (\[[tracker-body-writes]\]).
- Carrier rows that get regenerated restate their body (current state only, size-capped) and
  move superseded text to a ledger file.
- Keep a trap-list entry only where a tool's zero would otherwise read as an absence.

Related: \[[review-economy]\] \[[integration-validates]\] \[[durable-records-not-handoffs]\]
