---
name: deploy-success-is-not-live
description: When confirming that a NixOS/microVM/home deploy actually changed the running system
type: trap
---

**Rule:** A green deploy proves the new configuration was built and activated somewhere, not that the running process uses it. Check the thing that is running.

**Why / measured:**

- Deploying a microVM parent host repoints `/var/lib/microvms/<guest>/current` at the new runner but does not restart the guest. The activation log, `systemctl is-active microvm@<guest>` and "Activation successful" were all green while the guest ran the old config.
- The parent's system closure does not contain the guest's unit files, so grepping the parent toplevel for a guest flag reads 0 while the flag is present. `nix store diff-closures` between parent generations shows only `source`, however large the guest change.
- An activation does not restart a unit whose definition did not change. An ownership fix outside the unit file needed a manual restart.
- After a deploy, the running shell kept its old alias, which baked in an old store path. It went on using the old binary until a fresh shell was opened.
- `is-active` reads `active` for a crash-looping unit too.

**How to apply:**

- microVMs: compare `readlink -f .../current` with `readlink -f .../booted`. If they differ, the change is not live: `systemctl restart microvm@<guest>`. Inspect `/var/lib/microvms/<guest>/toplevel` for guest content.
- Read the journal, not `is-active`, for unit health.
- Open a fresh shell after changing aliases or wrappers.
- Deploys to shared hosts are the owner's act unless explicitly delegated.

Related: \[[per-machine-state]\]
