---
name: per-machine-state
description: When a fact depends on which host, checkout, environment or moment it was observed on
type: trap
verified: unverified
---

**Rule:** Clone sets, paths, DNS resolution and environment variables are per machine. Re-measure them on the host you are on, and record an observation with its domain: host, checkout and time.

**Why / measured:**

- A note said a config corpus held 20 clones while listing 19 names. Another session found one missing and recorded it as a deletion. It was a different machine with a different clone set. A clone added later silently changed ten figures in a spec written against the older set.
- A stale checkout of the same remote sat under an old directory name. Three times in one session, a bare `ls` returned a true fact and a false conclusion: it cannot tell the canonical tree from an abandoned one.
- An SSH host alias resolved to a CDN that completes the TCP handshake and then blackholes SSH. `ConnectTimeout` covers only the connect, so it never fired and the transfer "hung". The same alias resolved differently on each host. The overlay-network name worked; the command was never the variable.
- A tracker workspace variable set for interactive shells was unset under non-interactive `ssh host 'cmd'`. The error went to stderr, and with `2>/dev/null` it read as a real 0.
- One directory in the corpus was not a git repo, so every `git grep` over the corpus silently skipped it (88 files).

**How to apply:**

- `ls` the set every time. Never quote a remembered count.
- Identify the canonical tree by its remote and HEAD date, not by its presence.
- Never write an inference into durable memory as an observation. Write what the command printed, and mark the rest as inference.
- Where an independently recorded count exists (for example a pinned file count), reproduce it first to validate your sweep's domain.
- Over SSH, `cd` to the workspace and export what you need explicitly.

Related: \[[memory-is-not-evidence-about-head]\] \[[deploy-success-is-not-live]\]
