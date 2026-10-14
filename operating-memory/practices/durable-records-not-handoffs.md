---
name: durable-records-not-handoffs
description: When closing a session, writing a handoff, offering a "stop here?" checkpoint, or regenerating/closing a tracker item that others depend on
type: practice
---

**Rule:** Every live obligation lives in a tracker BODY. A handoff file carries pointers, each
with its reason. At close, audit every in-progress row: the status is a claim about the world.

**Why:**

- An obligation lived only in a handoff file that was wholesale-replaced at every close. It
  rode four consecutive handoffs verbatim, undecodable, with each session re-copying a token it
  could not expand. The first session to trim the line drops it, and nothing says so.
- At one close, two of four in-progress rows lied. One carried its only obligation in the
  replaced file. One held an open fixes-required verdict plus three unfolded rulings, behind a
  deferral whose trigger (a gate exiting) died with the session that owned it.
- Handoffs grew to 170 to 190 carried ids derived mechanically (predecessor ∪ today − closed),
  most with no reason attached. Owner: "it's to track work with purpose of execution, it's not
  to replicate the contents of the tracker. If you don't know /why/ you're carrying something,
  remove it."
- A blocker's own table listed four owed items, none of which was why the dependent row
  blocked on it. The real ground (a live dependency cycle) was recorded only on the BLOCKED
  row. A regeneration in flight would have produced an authoritative-looking body that read
  nearly done.

**How to apply:**

- The tell: a phrase you are about to re-copy that you cannot expand from the graph. Decode it
  now, or it is already dead.
- Per in-progress row, ask: who is on it, what is it waiting on, and is that thing still alive?
  A deferral is only as good as its trigger.
- Every carried id sits beside its reason (owed to the sitting, a named next dispatch, a live
  chain). Drop ids without a known reason; they remain findable in the tracker.
- Re-verify inherited state claims ("NOT PUSHED") with an explicit fetch.
- Before regenerating or closing a carrier, take each blocking edge and ask what the blocker's
  body says about it. Where it is silent, carry the ground back from the blocked row, marked as
  relayed.
- Before offering a "bank and stop?" checkpoint, make a cold-start resume possible from the
  durable records alone. Resuming a heavy session just to act on the answer defeats the point.
- A gate script that refuses a silent drop of a not-closed id, with an explicit
  acknowledgement for deliberate drops, makes this enforceable.

Related: \[[tracker-body-writes]\] \[[keep-the-fleet-full]\] \[[memory-architecture]\]
