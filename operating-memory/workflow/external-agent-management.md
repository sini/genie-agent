---
name: external-agent-management
description: How an orchestrator manages an external coding agent (another harness, reached over a message bus) - brief shape, required report shape, independent mutant verification before landing, queue file, idle nudging, and live-service limits.
type: workflow
---

# Managing an external coding agent

**Rule:** The external agent builds on a BRANCH and never pushes. The orchestrator re-runs the suite
and at least one key mutant ITSELF, RED then GREEN, before landing. Do not take an agent's word for it.

**Why (measured, anonymised):**

- An agent undercounted its test totals on three separate units.
- A unit's safety rested on a client of a real service; the mock-based test passed while the real
  client returned "allow" without waiting for the service.
- An oracle reimplemented the matching logic instead of driving the real delivery path; it passed
  regardless of the code under test.
- Guard mutants survived both of a unit's oracles until a later unit added a real one.
- A unit passed its checks, then CI went red after landing: an oracle depended on filesystem
  directory-listing order.
- A test used a tool absent from the sandboxed package build; CI's dev shell did not catch it and it
  surfaced only when a deploy failed. A sandboxed package build is a gate.
- Mutants hung instead of failing until per-test timeouts were added.
- A type-check break shipped because the agent had not run the package check.

## The queue file (source of truth for the agent's work)

Keep `<dispatches-dir>/QUEUE.md` current on EVERY dispatch and landing: a table of
`unit | repo | brief | base sha | status`, plus a Done table with the landed sha and how it was
verified. Either side can compact; the file survives. Tell the agent: "if you have lost track,
re-read QUEUE.md, take the first row that is not landed, and read its brief. One unit at a time, in
order. Commit on the unit's branch, never push, then send the report while still in the turn."
Keep a verbatim copy of every brief in the dispatches directory.

## Brief shape

```
# dispatch: <unit> - <one-line title>
Repo: ~/repos/<repo>, from main <base sha>. Work in a worktree:
  git worktree add -b <branch> ../<repo>-<unit> <base sha>. Do not push; report back over <bus>.
## Why        - the defect or risk, with file:binding pointers and the spec row
## Build      - the change, as bullets; fail-closed choices stated; any decision the agent has to
                make is named with a recommended answer ("decide and state the rule")
## Scope      - what not to touch
## Gating oracles (each RED under its mutant, then GREEN)
  1. <behaviour>. Mutant: <exact source change> => RED.
  2. ...
  N. every existing oracle stays green.
## Gates      - formatter, linter with warnings as errors, unit tests, the flake/CI check, the
                sandboxed package build; run each mutant under `timeout`
## Report (required shape)
```

Mutants are SOURCE EDITS, not runtime flags or env switches: a `MUTANT_*` switch left in a
security path was removed in review.

## Required report shape

- sha and diff stat;
- a mutant table the agent RAN ITSELF: exact code change, oracle, the RED output line, then GREEN;
- full suite count before and after (sum every result line), lint/format, flake check, CI read;
- premises that did not hold.
  Say in the brief: "every landing is verified independently; coverage claims are re-run, so report
  only what you ran."

## Orchestrator verification before landing

1. Rebase the branch onto current main (rebase, not merge).
2. Re-run the full suite yourself; compare totals with the report.
3. Apply at least one key mutant yourself; see it RED at the named line; revert; see GREEN.
4. Run the sandboxed package build and the formatter check.
5. Fast-forward main, push, read CI TO COMPLETION; fix forward if red. Record sha + verification in
   QUEUE.md.
6. A round that returns twice: hand the next round to a different builder rather than looping.

## Idle agents and waits

- External agents ack fast and then stand idle when told to; that is expected. When the queue has a
  ready row, send the next brief; do not wait for the agent to ask.
- Agents stall waiting for background-task notifications that never arrive. Briefs say "poll the
  result yourself".
- An agent idle without a report: check the TREE first (branch, commits, report path) before
  re-asking; work named by path is usually recoverable.

## Live-service limits

- No live-service change (deploy, data store, account, memory bank) without the owner's go-ahead
  relayed by the orchestrator. Measured: an agent created a live storage bank unasked.
- Subagents never deploy and never use the owner's hardware keys.
- The orchestrator asks the owner before a NEW CLASS of live change, even under standing authority.
- If a peer session also deploys hosts, message it before deploying anything it may touch, and never
  deploy concurrently.
- Every deploy that restarts a shared service: verify dependents re-register, and read the running
  binary's version, not the config's.

Related: \[[dispatch-form]\] \[[role-build]\] \[[roles-common-protocol]\]
