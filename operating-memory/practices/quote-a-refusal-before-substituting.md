---
name: quote-a-refusal-before-substituting
description: When a tool or harness refuses an action (resuming a stopped agent, a push, a send) and you are about to pick a workaround
type: practice
---

**Rule:** When a tool refuses, retry it once and show the user the exact refusal text. Only then
choose a substitute, and say which. Do not claim an override exists unless you know one.

**Why:** A message to a stopped agent returned "was stopped by the user and won't be resumed". The
orchestrator paraphrased that and launched a fresh agent. Owner: "The stopped agent can be resumed,
you didn't try" and "You should have tried again, surely there's an override." A paraphrase hides
what the harness actually said, and a silent workaround replaces a decision the user wanted to make.

**How to apply:**

- Retry once, quote the response verbatim, list the options.
- Before resuming a stopped agent, stop any replacement working the same worktree (one writer per
  worktree).
- For a permission refusal, do not reshape the command to slip past it
  (\[[claude-code-permission-classifier]\]).

Related: \[[resume-failed-agents]\] \[[one-writer-per-checkout]\]
