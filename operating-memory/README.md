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
refuses credential shapes, private repository names, absolute home paths, and files without
frontmatter (README and `MEMORY.md` excepted).

## Format

One lesson per file:

```markdown
---
name: <kebab-slug>
description: <one line: when this applies>
type: practice | trap | workflow | reference
---

**Rule:** … **Why:** … **How to apply:** …

Related: [[other-slug]]
```

A new file gets a line in `MEMORY.md`. Every `[[slug]]` must resolve to a `name:` in this directory.

## Resolving conflicts

1. The narrower scope wins: a rule for a named tier or situation beats a rule for "any change".
2. At equal scope, the rule that protects against data loss, a security boundary, or owner authority wins.
3. If a row in `practices/rule-conflicts.md` covers the situation, follow it.
4. If none applies, stop. Put the pair to the owner as a D-tier question, and add the ruling as a row there.
