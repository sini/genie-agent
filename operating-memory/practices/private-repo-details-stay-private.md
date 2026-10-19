---
name: private-repo-details-stay-private
description: Before quoting code, paths, shas or names from a repository you were given access to in a public room or thread
type: practice
---

**Rule:** Quoting specifics in a public answer is generally fine. The exception is the contents of a
PRIVATE repository: check its visibility first, and describe the cause and fix generically until its
owner says yes to disclosure.

**Why:** An assistant answered a user's question in a public room by quoting their private repository:
a commit sha, organisation and package names, file paths. The repo's visibility had been noted when
access was granted. The user asked for the message to be deleted. The correction was not "don't reveal
details" but "don't ignore a privacy fact you already hold". Removal after the fact does not reach
bridges or notifications already sent.

**How to apply:**

- Before replying from a repo you were given access to, check `gh repo view --json visibility`, or
  what was noted at access time.
- Private: ask the repo owner in the thread before disclosing specifics, and use placeholders until
  they answer. If they decline, deliver privately (a branch or PR in that repo).
- If a leak happens, remove it by redaction, never by editing it, and still treat prevention as the
  fix.

Related: \[[public-artifact-hygiene]\] \[[steer-without-visible-reversal]\]
