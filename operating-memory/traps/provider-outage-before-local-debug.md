---
name: provider-outage-before-local-debug
description: When several agents die with an infrastructure-shaped API error (529 overloaded, gateway hints)
type: trap
verified: unverified
---

**Rule:** Check the model provider's status page and correlate timestamps before debugging any local component. If there is a named incident on the tier you are dispatching, pause dispatch.

**Why:** An error read "529 Overloaded ... If it persists, check your inference gateway (<local address>)". That last clause is boilerplate printed whether or not the gateway is at fault, and it points at the one component you can poke, so it is the tempting hypothesis. Three subagents had died, and the session was about to debug a healthy proxy. The provider's incident had started minutes before the first death and named the exact model tier. All three deaths came after it, all on that tier.

**How to apply:**

1. `curl -sSL https://status.anthropic.com/api/v2/incidents/unresolved.json`. The `-L` matters, because the bare URL redirects and a naive curl returns HTML.
2. Line up the incident's `started_at` and affected models against the agents' death times and model tier.
3. Your own session goes through the same gateway, so if the gateway were down you would not be talking. That is a stronger control than a `/health` endpoint.
4. During a named incident, retrying burns budget. Wait for clearance, then resume the latest attempt of each failed agent rather than respawning from scratch.

Related: \[[claude-code-agent-messaging]\]
