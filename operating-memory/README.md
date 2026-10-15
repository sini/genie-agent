# operating-memory

The operating memory for genie's agents, and for anyone running their own multi-agent coding workflow:
how to orchestrate, dispatch, verify and land work, the measured traps behind each rule, and a reference
for every gen library. `MEMORY.md` is the index. Load it, and open a file only when a line's hook
matches the situation. Every file is self-contained: the rule, why (a measured incident), and how to
apply it.

It differs from `support-memory/`, which holds facts for answering support questions. This directory
holds working practice. Nothing in it widens an agent's tools or trust: those come from the tool
surface and the tier, never from memory.

## Admission

The admission rule is the same as `support-memory/`'s: a human merges a pull request. The
`support-memory` check in `ci/` also runs over this directory, and it can only refuse a change. It
refuses credential shapes, private repository names, absolute home paths, files without
frontmatter (README and `MEMORY.md` excepted), an unindexed file, a type outside the enum, a dangling
`[[slug]]`, a malformed `values:`, `verified:` or `scope:` field, and a `type: trap` file without
`verified:`. On every run it prints the provisional values and the unverified files: that list is the
owner's review queue, and it never fails the check.

## Format

One lesson per file:

```markdown
---
name: <kebab-slug>
description: <one line: when this applies>
type: practice | trap | workflow | reference
verified: <YYYY-MM-DD>; <tool> <version>[, <tool> <version>]     # or: unverified
scope: local                                                     # optional
values:                                                          # optional
  <short-key>: owner-set <YYYY-MM-DD> | measured (<how>) | provisional
---

**Rule:** … **Why:** … **How to apply:** …

Related: [[other-slug]]
```

A new file gets a line in `MEMORY.md`. Every `[[slug]]` must resolve to a `name:` in this directory.

- `verified:` is required on every `type: trap` file and on a `gen/` reference that makes concrete
  tool or evaluator claims; it is optional elsewhere. It names the date and the tool versions on which
  the claim was last re-run. A claim nobody has re-run says `unverified`.
- `values:` lists each threshold, limit or count in the body that is a policy choice. The number stays
  plain in the body; the map says where it came from: set by the owner on a date, measured (and how),
  or provisional.
- `scope: local` marks a rule that encodes one setup's choices (a shell, an agent cap, a house git
  policy, a host or tool) rather than a general truth. A downstream user should rethink it before
  adopting it. There is no overlay mechanism; the marker is the whole feature.

## Practices, lessons and retirement

A practice is a binding rule. A lesson is supporting context or evidence and does not bind on its own.
A file retires when its trigger no longer reproduces or a newer rule supersedes it. The replacing file
records it in a short "supersedes X" note, and the retired file is removed together with its
`MEMORY.md` line. There is no promotion schedule and no periodic sweep.

## Resolving conflicts

A conflict caused by wording is fixed by rewording one of the two rules. A genuine trade-off gets a row
in `practices/rule-conflicts.md`. An unknown conflict goes to the owner, and the resolution becomes a
row. There is no general precedence order between rules.
