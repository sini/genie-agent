---
name: reviewer-findings-are-hypotheses
description: When acting on, relaying or filing an adversarial reviewer's findings, and when applying fixes from a review round
type: practice
---

**Rule:** A reviewer's finding is a hypothesis on exactly the same terms as an author's
claim. Re-derive it before building on it, and treat the FIX as the highest-risk surface of
the next revision.

**Why:**

- A gate asserted that renaming labels changes the emitted vertex order. The claim was
  transcribed faithfully into the next revision as the ground for a design choice. The next
  gate refuted it with one `nix eval`: order is invariant under label spelling. Neither party
  had run a probe that took seconds. Findings arrive wearing the authority of the adversarial
  process, so they get transcribed where an author's own claim would get checked.
- The fix for the severest finding of a round introduced a new mechanism defect. A false
  *reason* was replaced by a false *construction*.
- A remedy can be right while its severity argument is false. That is the dangerous
  combination, because the false "why" becomes load-bearing prose.
- A returning reviewer decays on text it has already approved. One gate found, in round 3,
  two defects present in round 1 text it had read line by line. Its own diagnosis: reading to
  check that corrections were absorbed is a different activity from reading to find what is
  wrong.
- A retraction that lands in a spec's body often fails to land in the copy filed as a ticket,
  and the ticket is what gets acted on.

**How to apply:**

- Relay evidence in a form that can be re-run: paste the command, not your summary of it.
  One paraphrase dropped an `--override-input` flag, and the gate then concluded the author
  had concealed the override.
- Write "the reviewer concludes X; I have not measured it" for any unmeasured severity.
- In the next dispatch, name the fixes as the primary review surface, and re-run each
  finding's own predicate across its whole class, not just at the sites the fix names.
- Ask a returning gate to list the sections it has now approved more than once, and point a
  fresh reader at those.
- Re-check a finding against the primary at filing time.
- Ask reviewers for retractions of refuted earlier findings, and record them with reasons, or
  the rejected version gets proposed again.
- If the gate is unavailable, record it as OWED. A third pass over your own reasoning is not
  an independent contact.

Related: \[[brief-premises-are-hypotheses]\] \[[gates-need-an-oracle]\] \[[conclusion-and-basis-are-two-findings]\]
