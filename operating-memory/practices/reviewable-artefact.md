---
name: reviewable-artefact
description: When a spec or design is going to adversarial review — making its executable core small, frozen, hashable, runnable and self-verifying.
type: practice
---

**Rule:** The reviewable artefact is the executable core, hashed. Prose is commentary,
re-derivable from it. Freeze and hash the core before review, put the recipe and hash IN the
artefact, and make the core run and fail under mutation.

**Why:**

- A design spec grew from 452 to 1720 lines over five review rounds while its executable block's hash
  never changed. Every defect after round 3 was prose contradicting prose. The reviewer: "equation
  verification no longer finds anything, and prose auditing is unbounded."
- One spec printed its extraction recipe and sha256; every reviewer re-ran it independently. Another
  said "the core moved, re-attest it" with no hash or recipe; the anchor lived only in the
  orchestrator's notes and matched nothing. Later the hash proved right and the RANGE wrong, off by 16
  lines because the header above it had grown.
- Two specs shipped "executable cores" that did not evaluate (invalid syntax, undefined helpers,
  pseudocode shell). Reviewers had to rebuild the instrument from prose. Writing a real runner found a
  pairing step the prose specified and the pseudocode omitted.
- A comment-only commit between freeze and review shifted lines by one and invalidated five line
  references in a frozen document.
- A 14-row measured table was compressed to one line plus "full table in the agent transcript", and
  the agent was stopped. The rows were unrecoverable.

**How to apply:**

1. Keep the core contiguous between explicit BEGIN/END markers; derive boundaries from those markers,
   not from line numbers.
2. Prefer a separate runnable file: `nix eval -f core.nix check` or `bash core.sh --self-test`. Check
   (a) it evaluates, (b) inverting one assertion makes it fail, (c) it covers the load-bearing
   mechanisms, not the easy half.
3. Two hash controls: perturb a line inside the core (hash moves) and append one outside (hash holds).
4. Freeze covers the cited tree too: state the commit citations are correct against, and cite
   cross-repo code with the pinned rev (`repo@rev/path:lines`).
5. Verify a claimed no-op change by AST (`nix-instantiate --parse` drops comments), with a mutated
   operator as positive control.
6. A prose-only delta gets a change log. Split the document rather than inline equations into prose.
7. Measured tables go into the tracker whole; a transcript is not a record.
8. Scope every verdict: which lines were executed, what was only sampled.

Related: \[[dont-review-a-moving-artefact]\] \[[spec-and-plan-before-code]\]
