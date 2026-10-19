---
name: claude-code-permission-classifier
description: When an auto-mode agent is refused a push or other shared-resource action despite an owner grant
type: trap
verified: unverified
---

**Rule:** A grant relayed in a brief is not consent the classifier can see. An allow rule matches only the literal command form. After a refusal, never reword or reshape the command to pass the matcher, and never re-route the action through yourself or another agent; hand the owner the exact command instead.

**Why / measured:**

- A subagent whose brief quoted the owner's push grant verbatim was still refused ("Modify Shared Resources"), and so was a read-only `ls-remote`. The subagent correctly reasoned that a relayed grant is not owner consent.
- An in-session owner statement cleared a refusal once. Another time it did not: after a subagent had been refused, the main session's own identical push was refused as "Auto-Mode Bypass", because it looked like re-routing a denied action.
- An allow rule such as `Bash(git push origin main)` does not match `git -C repo push origin x:main`, `push origin <sha>:refs/heads/main`, or any `&&` compound containing a push. Env-var prefixes and `$(...)` also break the match. A matching rule resolves before the classifier.
- Even the matching form went through 7 times and was refused on the 8th. An allow rule does not guarantee the classifier is skipped.

**How to apply:**

- For a landing wave, ask the owner up front for a permission rule, or for the owner to run each push themselves.
- Only when the owner has installed an allow rule for a literal command, issue exactly that literal command. If it is refused, do not reword it and do not retry it from another agent; hand the owner the exact command.
- Brief build agents to push a branch, and to stage everything and write the exact push commands when refused.
- The orchestrator lands the branch from the shared checkout, on `main` and clean: `git merge --ff-only <sha>`, then a bare `git push origin main` as its own tool call, never inside an `&&` compound. In one session a compound push was refused even after an in-session owner grant; once auto mode was exited, the plain form went through at once.
- Route agent-to-agent sends through a narrowly allowed tool, not ad-hoc Bash that carries tokens.
- When reviewing a messaging or identity system, check where every claimed identity comes from, not just that a check exists.

Related: \[[git-worktree-and-remote-traps]\] \[[claude-code-agent-messaging]\]
