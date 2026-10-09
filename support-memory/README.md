# support-memory

The curated memory `genie-expert@public` reads (design §5.2 layer 5, row 13). It is the only
memory that instance reads. It is mounted read-only from a root-owned clean clone of this
repository's `main`, so a change reaches it only after it is merged and the clone syncs.

## Admission

An entry is admitted only by a human merging a pull request (design §4 step 7, oracle 20). The
`support-memory` check in `ci/` can only refuse a change. A green check admits nothing, and no
model or bot merges here.

## Format

One fact per file, as markdown with frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary>
metadata:
  type: reference
---

<the fact, and the public source it comes from>
```

Every entry cites the public source it was drawn from, by repository and path.

## What may not go in

- Secrets of any kind: tokens, keys, passwords, or anything shaped like one.
- Content from a private repository, or a private repository's name.
- Personal data about anyone.
- Anything from the owner's private memory that has not been rewritten for public use.
- Local paths from anyone's machine.
- Instructions to the agent that widen its tools or its trust. This directory holds facts for
  answering questions, not policy.

The check refuses credential shapes (the redactor's patterns), known private repository names,
absolute home paths, and entries without frontmatter. It cannot recognise a prose leak, which is
why a human reviews every PR.
