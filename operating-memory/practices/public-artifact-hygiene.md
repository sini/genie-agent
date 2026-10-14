---
name: public-artifact-hygiene
description: Before writing a commit message, PR body or code comment in a public repo — what must never appear in it.
type: practice
---

**Rule:** Version-controlled text (code, comments, commit messages) stays clean of people and of
operational detail. PR bodies may credit a reporter by handle. Nothing gets generated-by bylines.

**Why:** Commit messages on a protected main are immutable after merge. In one incident ten merged PR
bodies in a public infra repo leaked a VPN egress IP, a private network domain, internal topology and
library counts; scrubbing them needed manual revision-deletion per PR through the web UI (there is no
API for it). A handle written into a code comment outlives the conversation that justified it.

**How to apply:**

- No `Co-Authored-By` trailer in commits. No "Generated with ..." footer in PR bodies. Both are noise
  to the owner.
- Before `gh pr create` or a commit: scan the text for IPs, CIDRs, hostnames, domains, ports and
  counts, and generalise them ("the provider egress IP", "the UI host"). App names and file paths
  are fine; they are public through the code already.
- Reporter attribution: credit by handle in the PR body and in chat replies. In code and comments
  write "reported in the community channel" or "the reported shape". Commit messages default to clean.
- If a handle already landed in a comment on main and the person called it harmless, leave it rather
  than opening a follow-up PR just to remove it.

Related: \[[infra-changes-owner-deploys]\] \[[code-comments-cite-invariants]\]
