---
name: infra-changes-owner-deploys
description: When a change touches live infrastructure config (host configs, secrets, cluster manifests) — agents author and commit, the owner approves and deploys.
type: practice
---

**Rule:** An agent may author and commit infrastructure-config changes like any other build, but it
never runs a switch, deploy or rollout to a live host. Deployment is the owner's act. Secrets follow
the same split: the agent wires the mechanism, the owner decides what root-of-trust material exists.

**Why:** An infra change (a session hook, a packaged tool, a service) alters the environment every
later session runs in. Holding such work back as "unauthorised" stalls it; deploying it from a
session removes the owner's last checkpoint. The split keeps both: work flows, deploys stay human.

**How to apply:**

- Author and commit under the repo's normal conventions (linear history, module conventions). The
  report names the change for approval and says "deployment owed by the owner".
- Secrets: always use the repo's declared generators (for example `agenix generate` with
  agenix-rekey). Hand-encrypt only values issued externally, and document the provisioning procedure
  next to the declaration. Hand-rolled values fork provenance from the generators.
- A human-held master credential (the password that unlocks the vault the other secrets are recovered
  from) does not go into the repo, even encrypted. Encrypting it does not change what it is: it
  collapses a trust tier that exists only because it is held out of band. Build the consuming
  mechanism self-gated on the file's presence (`builtins.pathExists`) so it is fully inert without
  it, and never create the file. Offer a credential-free alternative.
- Do not generalise the credential rule to every root of trust. A CA root encrypted to a hardware key
  in the repo was ruled acceptable. Ask rather than extend a security ruling by analogy.
- In a public infra repo, keep PR bodies and commit messages free of IPs, CIDRs, real hostnames,
  domains, ports and operational counts. See \[[public-artifact-hygiene]\].

Related: \[[public-artifact-hygiene]\] \[[pin-container-images-by-digest]\]
