---
name: roles-common-protocol
description: The standing half every dispatched subagent role (scout, spec, gate, build) carries - measurement law, reporting disclosures, delivery and the stop protocol.
type: workflow
---

# Common protocol for every subagent role

## Measurement law

- **Every absence claim needs a positive control that FIRED**, same instrument, same run. A zero from
  a predicate that could not have matched is INVALID, not clean. See \[[controls-for-absence-claims]\].
- **Check a predicate's reach against the concept, not its spelling.** A true zero in the wrong
  library or under the wrong term produces a confident wrong conclusion.
- **Drive the check red and read it.** Produce the failing state and look at the output. Measured: a
  build whose edit silently wrote nothing returned `163/163` and its agent read that as success.
- **A probe whose two arms agree has measured nothing**, and neither has a one-armed probe compared
  with a figure from a document. Exhibit both arms from your own instrument, measuring the same object.
- **A report about an artefact is not a measurement of it.** Re-derive; do not relay.
- **Your brief is a claim set, not ground.** Briefs carried a false load-bearing claim in roughly half
  of sampled runs: either stale (true once, since fixed) or simply wrong (a count, path, cause).
  Test load-bearing claims before building on them. Emphasis marks protect nothing.
- **"At HEAD" is not a coordinate.** Re-derive any cited line, digest or path; say which copy you read;
  where a pin exists (lock file, store path, explicit sha) read the pinned revision.

## Shell facts that have caused false findings

- The tool named "Bash" may run zsh: unquoted `$list` does not word-split; `$pipestatus` not
  `$PIPESTATUS`; brace `"${sha}:path"` (zsh history modifiers otherwise mangle it and return nothing
  at exit 0); do not name a variable `path` (it is tied to `PATH`). See \[[zsh-is-not-bash]\].
- Read exit status UNPIPED: `cmd > out; echo $?`. See \[[read-exit-status-unpiped]\].
- Do not `2>/dev/null` a measurement: it turns a missing tool into an absence finding.
- `grep -c` counts LINES; prose wraps. For phrases: `tr -s '[:space:]' ' ' | grep -o 'phrase' | wc -l`.
  Carry the unit (lines / occurrences / files) in every figure. See \[[grep-wrapper-and-count-units]\], \[[grep-wrapped-prose]\].
- `grep -r` does not follow symlinks; `-R` does.
- A test summary of `0/0` is a FALSE PASS. Check the collected count agrees with the summary.
  See \[[nix-unit-collection-traps]\].

## Control tokens

A negative-control token (a string that must match nothing) is generated FRESH per run and not
written down. Once recorded in a report or prompt it is in the corpus, and later sweeps quoting it get
a plausible non-zero. Measured: one token matched 65 files because agents wrote it into reports; its
published replacement was burned by naming it in the warning. Use `/dev/urandom` or `$RANDOM`; report
the count and method, not the string.

## Reporting: three disclosures, each checkable

1. A premise of your brief that you FALSIFIED: lead with it.
2. A measurement you RE-RAN because the first was broken: both runs and the retained probe path.
3. Files you wrote via shell heredoc or script instead of edit tools: name them by path.
   State what you EVALUATED versus what you DERIVED. A partial result reported as partial is useful;
   reported as complete it is worse than nothing.

## Delivering

Write the deliverable file AND send a message to the orchestrator (a background agent's final text
reaches nobody). Send: the path verbatim; the verdict in one line; any stop signal in full; your
hand-off recommendation. If you wrote nothing or failed, send that.

## Stop protocol (you do not dispatch your own agents)

- `NEEDS_CONTEXT`: name exactly what information, and where it likely lives.
- `BLOCKED`: name the blocker (another writer, a missing ruling, a failed precondition).
- `STOP-AND-PROMOTE`: a genuine design question. Name it, give the arms, do NOT pick one.
  Returning early with one of these is a good outcome. Improvising past a gap is not.
  A brief that contradicts itself is none of the three: take the arm whose failure a reader can SEE,
  and name both arms and your choice. If you cannot tell, that is STOP-AND-PROMOTE.

## What you report, not file

Docs drift (counts, prose, anchors, README) is reported and fixed in a landing, not filed. The
tracker is the orchestrator's. A user-facing surface (tool, demo) is accepted only when the OWNER has
run it; agents' green is not acceptance.

## Memory bank

Recall BEFORE your first measurement, by subject (tool, library, kind of measurement), not by task
id (that returns nothing and reads as an empty bank). Filter recall to raw facts and experiences, not
derived observations: measured, a derived observation inverted the source fact it summarised while
keeping its "measured" tag. Retain a trap only if it would change what a stranger does months from
now; write it as a rule with its command and its control (`X => 0 at <sha>, live control Y => 9`).

Related: \[[role-build]\] \[[role-gate]\] \[[role-scout]\] \[[role-spec]\] \[[dispatch-form]\]
