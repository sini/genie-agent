---
name: writing-a-dispatch-brief
description: Before sending any prompt to a build, spec or review subagent — what every brief carries, what it must not, and the checks that catch the defects that ship in briefs
type: practice
---

**Rule:** Specify the PROPERTY, the forbidden shapes and the oracle; leave the MECHANISM to the agent
unless it is ruled ("this is ruled, not chosen"). Resolve every uncertainty before writing: the brief
carries conclusions and pointers, never reasoning. Read the finished brief as ONE document and ask of
each instruction whether another section forbids it. Premises: \[[brief-premises-are-hypotheses]\].

**Why:**

- A mechanism in a brief is a ceiling. Three agents each beat the mechanism handed to them, and said
  so: a structural invariant (parent options ⊆ child options on every inheritance edge) instead of a
  "fail if the count reverts" cell a pinned number could satisfy; one `git rev-parse --verify --quiet "<rev>^{commit}"` instead of a two-step check; a withdrawn claim instead of a re-aimed one ("replaces
  a false claim with a second false claim"). Checkable only because declared.
- 4 of 9 dispatches in one plan held thinking-out-loud ("WAIT", "ACTUALLY"); the failed one said
  "remove the flat fields" in its goal and "WAIT... keep them" in its body.
- The contradiction that ships is quieter: a correct premise beside a wrong instruction. Four in one
  session: a premise forbidding what the scope asked; "your report file only" next to an unscoped "push
  to main" (twelve unrelated commits pushed); a random token demanded inside pure Nix evaluation;
  "restate the dates" turning a marked quote into a paraphrase. A worktree fence made the spec's own
  two-file acceptance oracle unsatisfiable. A relayed gate exit required the very phrase the ruled
  repair deleted: a fixture built to identify a site is not a model of the repair.
- A review brief named three finding labels from the OTHER lane's report; "does the label exist"
  false-greened, because a report rejecting a label quotes it. Position discriminates: a real finding
  sits at a heading or table-row start. Six literal FAIL-IF phrases tripped on correctly preserved
  quotes of refuted claims.
- A class sweep given one exemplar shape found 5 wrong items, none of that shape. Authors fix the
  instance, not the class (the same lesson violated one section away three times). An author's
  "sections unchanged" list was wrong on 5 of 5 revisions checked, always overcounting.

**How to apply — every brief carries:**

- the property, the oracle, and what a FAILING run looks like;
- "a better mechanism is welcome, but NAME every departure, improvements included" (a gate handed one
  deviation that finds two must assume a third);
- "report no figure you did not obtain by running a command; state coverage as a limit (read in full /
  grepped only / not evaluated)"; an unmeasured figure is written as its command or "not measured",
  never as a placeholder in the figure's format;
- a disk path for EVERY deliverable (\[[agent-report-delivery]\]); "never use pkill/killall or kill
  pgrep -f output" (\[[kill-only-captured-pids]\]); a memory cap for heavy evaluation
  (\[[cap-every-heavy-evaluation]\]); the population by membership (\[[scope-by-membership]\]); anchors
  as binding names (\[[cite-by-binding-not-line-number]\]);
- a write / commit / commit+push verb per repo. Fence a repo only where a competing writer exists, and
  never over files the spec lists as outputs. Tie-break: "where this brief and the spec disagree, the
  spec governs";
- a class named by a predicate the agent re-runs; an exemplar only as a mandatory known positive;
- for revisions: "for each claim, what CLASS does it quantify over, and did you check all of it";
  "derive the unchanged list by section diff"; borrowed claims restated as the weakest the source
  supports; every deleted identifier grepped across the whole document;
- FAIL-IF conditions that tell a live claim from a quoted refuted one;
- for reviewers: read and reason, do not word-sweep (a design in its own vocabulary can entrench a
  retiring construct without using its words); ask separately whether theory, mechanism and argument
  survive.
- Everything the landing needs goes in the OPENING dispatch (\[[relay-through-the-hub]\]). Ask what you
  changed in this repo this session (pushes, HEAD, lock revs) and whether the spec speaks to it. List
  only items to act on, never items to skip. Re-read this file before every dispatch.

Related: \[[brief-premises-are-hypotheses]\] \[[dont-review-a-moving-artefact]\] \[[delegate-authoring]\] \[[spec-and-plan-before-code]\]
