---
name: act-on-clear-remediations
description: When a defect surfaces mid-work with an obvious fix, or the user's instruction already says "fix X" / "clean up X"
type: practice
---

**Rule:** Do not acknowledge and move on. Execute the clear half of a defect in the same turn,
and send only the genuinely ambiguous half to the owner, as a fork with a recommendation. When
the instruction was "do X", do X; do not audit, then ask "want me to?".

**Why:** a session twice narrated hook defects ("the hook stashed unstaged files", "the hook
reformatted and aborted, re-staging") and moved on. Owner: "don't just acknowledge defects
which have a clear and obvious root cause remediation — act on them; if there's ambiguity
raise it with the owner." An acknowledgement that changes nothing is scroll noise, and the
defect fires again next session. The tracker item even carried a priced remedy that nobody had
executed. Separately, asking for confirmation after completing an analysis that was already
requested wastes a round trip and ignores the instruction.

**How to apply:**

- Split each defect:
  - CLEAR: a measured current state with a known fix (regenerate stale snapshots, fix the
    wrong pointer). Execute it now.
  - AMBIGUOUS: a design fork, a fleet-wide surface, a cost trade-off. Bank it on the tracker as
    a fork with a recommendation.
- Neither half is "noted for later".
- Reserve confirmation for genuinely ambiguous scope, or for risky or destructive actions.
- In a brief or report, "fixed in this landing" beats "filed for follow-up" for docs drift,
  stale comments and citation anchors. Those get no ticket at all (\[[filing-caps]\]).

Related: \[[before-asking-the-owner]\] \[[advance-on-reversible-defaults]\]
