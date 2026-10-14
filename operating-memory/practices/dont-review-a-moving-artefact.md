---
name: dont-review-a-moving-artefact
description: Before dispatching a reviewer/gate at an artefact, and while one is reading — making sure the thing reviewed is the thing that exists.
type: practice
---

**Rule:** Freeze and hash the artefact before dispatching a review. Do not gate an artefact whose
author is still running. Hold commits on any path (or commit range) a live reviewer is reading.

**Why:**

- An orchestrator sent an author three corrections mid-run, took its FIRST return as the finish, and
  dispatched a reviewer. The author absorbed the corrections in a second round, growing the spec from
  +45 to +181 lines. The review opened on a version that no longer existed.
- Hours later: the orchestrator sent "context only, do not widen", the agent went idle, the reviewer
  was dispatched, and the file then moved again by +32 lines because the agent was still draining that
  message. An idle notice attests to the state when it was emitted.
- Committing a spec into an unrelated commit while a delta review was mid-round broke its premise
  ("nothing is committed"); it had to re-pin to a commit range.
- A brief said "the delta is A..B, one file". The orchestrator then landed three unrelated commits in
  that range. The spec itself was untouched, but the range now held three commits and six paths: the
  premise was void.

**How to apply:**

- Before gating: ask the author to confirm DONE and to report, not apply, anything in flight. The test
  is "idle since my last message to it, with nothing I sent still unabsorbed".
- A "context, do not widen" message is the dangerous kind: it costs time in the file, which is what
  collides with a reader.
- Name the artefact's own last-touching commit (`git log -1 --format=%H -- <path>`), not a range. A
  range is a claim about every file in it.
- Tell the reviewer: "nothing you read will be committed while you are live", and to check the hash
  first and stop on mismatch.
- When it happens anyway: commit the new state, send the reader a fresh pin (sha, md5, line count,
  what changed), tell it REJECT-on-process is costless, and say plainly it was your error.
- Your own push or landing between authoring a spec and dispatching against it stales the spec's
  push-state claims. State the invalidation in the brief.
- Dispatch a gate only after the last content edit. Never let a sign-off message carry an
  instruction: separate messages, so nothing that closes a round can move the artefact.
- Anchor a gate on a committed revision. For an uncommitted artefact, use
  `git hash-object -w <file>` (an immutable blob id with no ref) and verify it with
  `git cat-file blob <id> | diff - <file>`.
- Gate side: snapshot `git status` at start and re-check before the verdict. On movement,
  halt, name the delta, and ask the hub.

Related: \[[reviewable-artefact]\] \[[writing-a-dispatch-brief]\] \[[peer-sessions]\]
