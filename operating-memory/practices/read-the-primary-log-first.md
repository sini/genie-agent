---
name: read-the-primary-log-first
description: When a running system shows a reproducible symptom and you are about to propose a cause or edit its config.
type: practice
---

**Rule:** Read the machine's own log before naming a cause or editing config. A config-versus-reality
mismatch spotted by reading config is a hypothesis, not a defect.

**Why:** A laptop's early-boot remote unlock over Wi-Fi failed. The agent noticed the config named the
interface `wlp0s20f3` while the hardware report said `wlo1`, declared that the bug, edited a deployed
host's config and swept the fleet for the same "defect". The owner said the change was wrong. It was:
systemd registers the losing name candidates as alternative names, and network `Match Name=` matches
alternative names too, so the config had matched all along. The journal, never asked for, named the
real cause directly: the kernel failed to install the Wi-Fi key because the initrd shipped the crypto
templates (`ccm`, `ctr`, `cmac`) but no AES cipher module. The fix was adding the AES modules to the
initrd's kernel modules, verified by extracting the built initrd and then by a successful unlock.

**How to apply:**

- Before naming a cause: is there a log that would settle this, and can I get it in one command
  (`journalctl -b`, the unit's log, the service's own output)? If yes, get it first.
- When two layers name the same object differently, check whether the consuming layer treats them as
  equivalent (aliases, alternative names, globs, symlinks, case folding) before calling it a mismatch.
- Do not sweep a fleet for a "defect" you have not confirmed on one host.
- Debug before reverting: find the cause, then decide.

Related: \[[armed-controls]\] \[[infra-changes-owner-deploys]\]
