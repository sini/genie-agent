---
name: nix-override-input-silently-inert
description: When overriding, updating or relocking a Nix flake input (`--override-input`, `nix flake update <name>`, `--update-input`), especially one that is nested/transitive or reached from a `getFlake` probe.
type: trap
---

**Rule:** Naming an input the flake you are in does not declare directly is accepted silently. Prove
every override or relock from stderr and from the lock's node table, never from the command's exit
code. Two byte-identical arms are the signature of an inert override.

**Why:** Measured, all exit 0:

- `nix flake update foo` and `nix flake lock --update-input foo` print a warning ("does not match any
  input of this flake"), change nothing, and exit 0 when `foo` is nested under another input (`hub`).
  Measured four times on four inputs in one session. The slash path works: `nix flake update hub/foo`.
  A no-op relock followed by a green suite is a pure false green: nothing changed, so nothing broke.
- `--override-input child <path>` on a TRANSITIVE input is accepted, no error, and the locked rev the
  evaluation uses does not move. Where the same input is direct, stderr prints
  `Updated input '<name>': ...`, the proof. Use `--override-input parent/child <path>`.
- On `nix eval --expr` / `--file` probes that reach the flake via `builtins.getFlake`, the flag does
  nothing. Measured with an override pointing at a stub flake with NO `lib`: exit 0, full answer, stub
  never consulted. Control `nix flake metadata --override-input ... .` showed the stub in the lock.
  Overrides are honoured only where the command itself resolves the flake ref (`nix flake check`,
  `nix flake metadata`, `nix eval "path:<copy>#..."`).
- Why it matters: a test row was checked for whether it discriminates pre-fix vs post-fix. Driven
  correctly, pre-fix both arms collapsed to one answer; with the inert override both arms would have
  read post-fix, "diverged", and certified a vacuous row.
- In a `ci/` sub-flake reaching siblings through a `path:..` input, target that PARENT input. Order is
  load-bearing: the parent node has no rev of its own and re-resolves against whatever the root lock
  says now. Relock the sub-flake first and it silently re-pins to the OLD root.

**How to apply:**

- Read `nodes.root.inputs` (`jq '.nodes.root.inputs' flake.lock`) first; assume every library is
  transitive in a consumer repo until you have.
- Look for the `Updated input` line on stderr; none means you measured the unoverridden tree.
- Relock root first, then the sub-flake via its parent path input:

```sh
nix flake lock --update-input foo          # root, where foo is direct
nix flake lock ./ci --update-input hub     # then the sub-flake
```

- For a transitive input under test, do a real lock rewrite by node path and restore it:

```sh
cp flake.lock flake.lock.bak; md5sum flake.lock
nix flake lock --override-input parent/child "git+file:///path/to/child?rev=<rev>"
# run both arms
mv flake.lock.bak flake.lock; md5sum flake.lock   # must match the first md5
```

- Diff node -> rev by node path before and after each step.
- An override that works REPLACES the whole input subtree, re-resolving its transitive edges. Say what
  else moved. Alternative: discharge the arm with `git diff <pin>..HEAD -- lib/` plus a control file.

Related: \[[flake-lock-node-name-is-not-identity]\] \[[repo-has-more-than-one-lock]\] \[[control-must-differ-on-the-failing-axis]\]
