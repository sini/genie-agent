---
name: confirm-baseline-before-claiming-a-gap
description: When a downstream config or corpus member fails under your new implementation
type: practice
---

**Rule:** A corpus failure is your gap only if the member evaluates on its own pinned baseline with no override AND fails under your override. Confirm the first half before declaring anything.

**Why:** Applied across a set of external user configs, this works-on-baseline gate produced zero false positives. Members that also failed on their own pin were broken or version-drifted and were skipped.

Related measured failures:

- The override pointed at a bare repo path, which resolves whatever branch is checked out. Two of four worktrees sat at an older revision, so a careless run would have confirmed a stale claim. Verify the revision in the trace.
- A completeness matrix both under- and over-counted. It marked one surface CLOSED on a synthetic-witness-only green while the real flake output was absent. A synthetic witness is not a corpus witness.
- Forks under different org names were the same upstream, so no fork was out of scope. A mid-sweep error sidelined some configs for being on a "different" fork.
- One measured config is one witness, not the corpus. An absence claim needs the set, and the project's own templates are the cheapest breadth. In one sweep only a template carried the defect shape, while every user config read clean.

**How to apply:**

- Use an `attrNames` probe for speed. The pipeline fails eagerly at an API gap.
- Name the witness count and the revision with every corpus claim.
- Treat the corpus as a symptom check and tool, not as the design bar. Design to surface expressibility, not to corpus presence.

Related: \[[oracle-design]\] \[[tested-path-equals-shipped-path]\] \[[per-machine-state]\]
