---
name: confidence-and-deeper
description: What the confidence line on a genie answer means, and what the reactions do.
metadata:
  type: reference
---

Every genie answer carries a confidence line (0 to 1) and the gaps it knows of. A first answer
comes from a local model; below a threshold, or on a hard trigger (an eval error it cannot
explain, code it cannot see, gen/den internals beyond its skills, or the user asking), it
escalates to the expert, whose reply is marked "expert review". The reactions: ✅ accepts the
answer, and 🔍 (or the text `!deeper`) asks for a deeper look. Only the asker or a trusted user can
trigger 🔍.

Source: `github:sini/genie-agent`, `docs/design.md` §4 steps 4 to 6.
