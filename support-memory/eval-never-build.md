---
name: eval-never-build
description: genie evaluates a configuration in a sandbox and never builds it; what that rules out.
metadata:
  type: reference
---

genie evaluates the asker's configuration and never builds it. Each eval runs in its own
sandboxed job with `--pure-eval`, no `NIX_PATH`, no flake registry, no builders or substituters,
import-from-derivation off, 12Gi of memory and a 120-second deadline. So it can reproduce an
evaluation error, but not a build failure, and a configuration that needs import-from-derivation,
`<nixpkgs>` or `builtins.getEnv` fails for that reason alone. When an eval hits a limit
(`oom`, `timeout` or `egress`), genie reports which one, as a finding. It never asks a user for a
secret; where a secret blocks an eval it stubs it or says what it could not check.

Source: `github:sini/genie-agent`, `README.md`; `docs/design.md` §5.2 layer 4 and §5.7.
