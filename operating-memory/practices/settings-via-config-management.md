---
name: settings-via-config-management
description: When a permission refusal or harness setting blocks an agent, and you are tempted to edit Claude Code settings from inside a session
type: practice
---

**Rule:** Do not change agent-harness settings or permissions from a session: no settings
skill and no hand-edit of `settings*.json`. If they are managed declaratively (for example by
home-manager, where agent definitions are store symlinks), a change is a config-repository
change made only on explicit owner instruction. Prefer needing no change at all.

**Why:** a scratch-clone commit by an agent was refused once by the permission classifier. The
owner said "allow commits and suites in the scratch clones", and the orchestrator reached for a
settings edit. The owner rejected it: "claude settings are managed through [the config repo].
Ideally no change is required." The agent's retry, with explicit owner/orchestrator
authorization written into its brief, then went through with no settings change.

**How to apply:**

1. Relay the explicit authorization in the agent's brief, and retry once. This is usually
   enough.
2. If a real change is still needed, PROPOSE the config-repository diff to the owner. Do not
   make it.
3. If the classifier refuses an action (a deploy, a public push) while the owner is away,
   report it. Do not route around it.
4. Check the grant before writing the rule. An instruction that names a tool absent from the
   agent's tool list reads as installed and can never fire (\[[agent-report-delivery]\]).

Related: \[[agent-report-delivery]\] \[[landing-and-history]\]
