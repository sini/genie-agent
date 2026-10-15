---
name: memory-architecture
description: Before saving a rule or trap to a memory store, when a memory is refuted or grows large, and at the end of a work phase — what memory holds, recall before retain, and how to fix or delete an entry
type: practice
values:
  audit-at-lines: provisional
---

**Rule:** Memory holds HOW TO WORK. Project state goes to the issue tracker, code structure to a code
index. Recall before you retain: search the store on the subject and add only on a genuine gap. When
a memory is refuted, fix its `description:` and index line FIRST: the body is the part nobody reads.
Update memories when a phase completes, so none describes a "next step" that already happened.

**Why:**

- A body-only fix never reaches the reader: `description:` drives recall and the index line drives
  context. The memory keeps asserting what you disproved.
- One corpus reached 145 files and 5,914 lines, 56% project state, one file at 927 lines: it flooded
  context if recalled and went stale if not. One rule file reached 238 lines, stopped being recalled,
  and a trap recorded verbatim inside it fired again. It was split into 25 one-line laws, with the
  cases moved to the tracker.
- After killing a stuck agent, an orchestrator stored the "`pgrep -f` matches its own wait loop" trap.
  Owner: "That's already a recorded trap and memory." Recall showed three entries. Duplicates split
  recall ranking and cost the owner a correction. A repeat of a known trap is a DELIVERY failure (the
  agent never received the memory); another stored copy does not fix it.
- Memories written at spec time and never updated left "next step is X" long after X shipped.

**How to apply:**

| holds                                       | where              |
| ------------------------------------------- | ------------------ |
| corrections, disciplines, earned rules      | memory (feedback)  |
| who the user is                             | memory (user)      |
| pointers to archives, repos, URLs           | memory (reference) |
| work items, status, decisions, dependencies | issue tracker      |
| symbols, callers, architecture              | code index         |

- Recall with the failure's mechanism words, not the session's names; read the top hits. Existing entry
  states it: cite it. Narrower: extend that entry. A recurring trap: fix the delivery path (the brief
  template or the tool), not the store.
- The index file is the only guaranteed read: one line per memory, rule plus pointer, enough to decide
  whether to open it.
- About 40 lines triggers an audit, default answer CUT: it is usually state, or two facts. Case studies
  are evidence; cite one and stop. The governing test: does it change what someone does, or explain why?
- At each phase end (spec approved, plan written, shipped, landed), update status and remove stale
  "next step" lines. Prune on contact: a stale memory carries authority it has not earned.
- A memory naming `file:line` is a hypothesis. Verify at HEAD before acting.
- Deleting is an inbound-link question: grep corpus-wide for wiki-links to the name with a positive
  control and repoint dependents. Verify both directions: every file reachable from the index, every
  index target present. Exclude sync-tool history directories (11 of 11 dangling hits were history).
- Do not let a compaction launder a false claim into a shorter false claim: re-check claims, not bytes.
- Promoting docs into a recall bank: retain LAW files, not ledgers (recall returns superseded wording
  at equal authority). Promote what is cited by an opaque number, not what is already auto-loaded.

Related: \[[durable-records-not-handoffs]\] \[[relayed-is-not-measured]\] \[[orchestrate-against-theory]\]
