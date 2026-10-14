---
name: read-shared-trees-at-committed-objects
description: When reading, committing or making claims about a tree or scratchpad another agent or peer session is working in
type: practice
---

**Rule:** Read a contended tree at a committed object (`git show "${sha}:<path>"`, `rev-parse`), or not
at all. A clean `git status` does not mean unmoved, a file existing does not mean it is finished, and
an absence on a live branch is not an absence. In a shared scratchpad, every agent writes to its own
absolute subdirectory with uniquely named outputs, and checks mtime before reading a file it did not
just write.

**Why:**

- **Clean is not unmoved.** A gate was warned a peer "may still hold" a repo. The peer had landed one
  commit past the spec's pin, +110/−3, in the exact file under review. Porcelain read clean in both
  states; only `rev-parse` separates them.
- **Already-done that never was.** A scout reported an item "already discharged", quoting a section a
  live agent had written minutes earlier. Sound method, conclusion about a state that did not exist at
  dispatch. Tell: an "already done" finding with no commit behind it.
- **One revision, three suite figures in one session:** dirty tree 166/531, `git archive` extract
  7/531, clean clone 531/531. A figure taken against a tree a peer holds measures no revision.
- **Torn captures.** A spec committed while its author still edited: 392 lines against 481 on disk. It
  announced an O1a/O1b split and had no O1b section, staged cleanly and read as complete. The author
  caught it by comparing its file to `git show HEAD:<path>`.
- **Partial-write figures describe nothing.** A diffstat read mid-write matched neither commit that
  resulted. Worse than stale: a stale figure was once true.
- **Racy absence.** "You did not commit it" was sent off `git log`; the reflog showed the commit landed
  ten minutes after the read and before the message arrived.
- **Scratch collisions.** Generic filenames (`probe.nix`) were replaced by another agent's file of the
  same name mid-task. An agent read a results file before its own run wrote it and got the previous
  round's complete, plausible, wrong numbers; the tell was the mtime, not the content. A brief saying
  "use a per-agent subdir `<name>-private/`" made seven agents create it in the repo root (their cwd);
  every brief giving the absolute path produced zero strays.

**How to apply:**

- Reads: `git show "${sha}:<path>"` (braced for zsh). Cheaper: commit first, then dispatch the reader
  against the commit.
- In a brief naming a tree a peer touches, ask for "the revision measured at", per tree, and treat any
  returned per-repo state as `[RELAYED]` until you ran `rev-parse` yourself. Expect your own
  coordinate to be one commit stale as the normal case.
- Do not stage a peer's deliverable until its idle notification arrives; a completion message is not
  a release (\[[agent-report-delivery]\]).
- If you commit anyway, verify the capture with a predicate the revision was *supposed* to add (line
  count plus a phrase only the new version has). A phrase absent from both copies is a dead control.
- Before sending an absence finding to a live agent: `git reflog show <branch> --date=iso`.
- After killing an agent: `git status --short` and `git diff` before dispatching a replacement.
  Restore the files, or tell the new agent what state it inherits.
- Scratch: `<scratchpad>/<agent-name>-private/` as an absolute path in the brief, plus "never create
  directories inside the repo". Name outputs per run (a task marker or `$(date +%s)`). A filename is
  not a claim about who wrote it: check mtime or provenance first.

Related: \[[one-writer-per-checkout]\] \[[agent-report-delivery]\] \[[agent-liveness-and-ownership]\] \[[delegate-authoring]\]
