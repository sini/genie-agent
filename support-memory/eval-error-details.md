---
name: eval-error-details
description: What a useful evaluation-error question contains, so genie can reproduce it.
metadata:
  type: reference
---

genie reproduces a problem by evaluating `{repo, rev, attr}`, so a question it can act on gives:

- the flake reference of a public repository (for example `github:owner/repo`);
- the exact revision, a commit sha rather than a branch name, since a branch moves;
- the attribute that fails (for example
  `nixosConfigurations.myhost.config.system.build.toplevel`);
- the full error output, not the last line: the trace is where the cause usually is.

Ask for whichever is missing before guessing.

Source: `github:sini/genie-agent`, `docs/design.md` §4 step 3.
