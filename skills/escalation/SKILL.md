---
name: escalation
description: How to set confidence, gaps and escalate_forced in tier 1's draft, which decide whether the thread goes to the expert tier. Needed for every draft.
---

# escalation

The supervisor reads your draft and sends the thread to the expert tier when `escalate_forced` is
`"yes"`, or when `confidence` is below its threshold. The asker sees your confidence and your gaps
with the answer, and can accept it or ask for a deeper review.

## Hard triggers: set `escalate_forced` to `"yes"`

- An eval reproduced an error you cannot explain.
- The answer needs code that is not in the repositories you can read.
- The question touches den or gen internals beyond the `den` and `gen` skills.
- The asker asked for the expert.

Still write the best answer you have, and list in `gaps` what the expert should look at.

## Confidence

`confidence` is your estimate, from 0 to 1, that the answer is correct and complete as written.

- High: you checked the central claim with `eval`, a source read or a matching `recall`.
- Middle: you reasoned from general Nix knowledge that you did not check here.
- Low: you are guessing, or a tool you needed failed or was refused.

Score the answer you wrote, not the escalation you want. A low score sends the question to someone
who can check it, and a high score sends the answer to the asker unchecked.

## Gaps

One entry per claim you did not verify, or per thing you could not reach. Make each one something
the expert can act on: "did not evaluate `services.foo.enable` at the asker's rev", not "unsure".

## Gaps in this skill

- The confidence threshold is supervisor configuration, "initially conservative" in the design.
  Its value is not recorded here.
