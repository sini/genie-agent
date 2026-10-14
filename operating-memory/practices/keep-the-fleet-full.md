---
name: keep-the-fleet-full
description: When a stream closes, an agent returns, or a session feels like a natural stopping point while context budget remains
type: practice
---

**Rule:** Below about 75% context, an idle or shrinking fleet is a DISPATCH TRIGGER, not a
finish. At every agent return, count live agents against the cap and fill EVERY free slot
from the whole ready frontier in the same turn. End a turn on a dispatch, or on command output
proving the queue is empty, never on a summary or a list of questions.

**Why:**

- A session closed six rows, published across five repositories, then summarised and stopped
  at 54% context. The owner had to prod it back. Tokens are replaceable; the owner's attention
  is not, and a session that stops early spends it on a prod instead of on a decision only
  they can make.
- Three times in one session a good summary ended the turn while the ready list held unblocked
  top-priority items. The owner asked "why did you stop?" each time.
- **Lane drain:** with a cap of 6, a session ran ONE agent while its main thread worked a serial
  chain. A later session refilled one slot per return (each return dispatched only its own
  successor), and the fleet decayed from 6 to 2. Another sampled 4 of 25 frontier rows and
  declared "the rest is the owner's"; reading all 25 found four agent-ready units.
- A relock was told to hold a landing out "to protect a perf bisection". That bought a full
  second 22-repository pass to save one benchmark re-read. Owner: "Why would you run two
  relocks back to back?"

**How to apply:**

- False stop conditions: "the fleet is drained" (a dispatch trigger), "everything is
  published" (a clean STATE, not an exhausted QUEUE), "the rest is the owner's" (read every
  frontier row's tail first), "a natural place to summarise" (a summary is not a deliverable
  unless asked for).
- Dump every frontier row's tail in one script and classify each. Also look at rows this
  session filed and at the orchestrator's own repository.
- The tell: a reply of the form "X is idle; still in flight: A, B" must also open a new lane, or
  name the ready row being skipped and why.
- Fold a landing that arrives mid-relock INTO that relock. Never queue a second one behind it.
- An owner question goes into a tracker row plus ONE line in the report, and then work
  continues. Resolve it provisionally where you can, with an overturn condition.
- An owner override of a budget gate supersedes the hook's printed gate text for that session.
- Budget gates belong to the arc that defined them. In an arc the owner is actively driving
  without a handoff gate, keep working and bank state continuously instead.
- An unexpected compaction below the gates: suspect harness features (idle compaction, a
  remote flag) before suspecting the thresholds, and tell the owner.
- An early handoff is work thrown away when the handoff file is wholesale-replaced at close.
  Bank obligations into tracker bodies as you go.

Related: \[[durable-records-not-handoffs]\] \[[advance-on-reversible-defaults]\] \[[filing-caps]\]
