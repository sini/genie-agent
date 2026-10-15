---
name: nix-which-flake-which-output
description: Before quoting a suite total, a formatter result, "this flake has no X", or "this repo is green": which flakes, which outputs, and what CI actually runs
type: trap
verified: unverified
---

**Rule:** Before quoting a total or calling a repository green, enumerate the flakes in the repo and
their outputs by asking nix from inside the repo, and enumerate what CI runs from the workflow file.
Name the instrument in every "green" claim.

**Why:** Measured in one library ecosystem:

- Across 33 repos the formatter was at `./ci#formatter.<system>` in every one that had a `ci/` flake
  and at the root `.#formatter` in none. One agent concluded the repos had "different capabilities";
  they had two flakes with one name.
- The literal `formatter` appears in neither `flake.nix`: the output comes from treefmt-nix through
  flake-parts. A grep says "no" in every repo where nix says "yes".
- A build was graded 230/230 against `nix-unit --flake ./ci#tests`. A second suite lived on its own
  output, `./ci#testsError` (71 cells), and two of its cells pinned the exact string the change moved.
  The build would have landed green and red the hidden suite next run.
- A refusal-test script (`bash ci/refusals.sh`) is a devshell command the workflow runs as a required
  step, invisible to `nix flake check`. On the same revisions the flake check was 24/24 green while the
  script went from 42 ok / 0 FAIL to 39 ok / 3 FAIL after a relock: three enforcers silently stopped
  refusing ("exit 0, wanted 1").
- In a hub repo, two CI gates were flake APPS (`nix run ./ci#<app>`). The workflow had 5 jobs / 6
  commands, and `nix flake check ./ci` covered one. Running the app locally caught a near-miss the
  15-check green would have passed.
  Enforcers are the worst place to miss: a broken normal test reds loudly, but a broken enforcer stops
  refusing, which looks exactly like a passing suite.

**How to apply:**

```sh
nix eval ./ci#checks.x86_64-linux --apply builtins.attrNames
nix eval ./ci --apply 'f: builtins.attrNames f' 2>/dev/null   # or: nix flake show ./ci
nix eval "./ci#formatter.x86_64-linux.name" --raw; echo "rc=$?"
```

- Read `.github/workflows/*.yml` and list every command. Checks live in at least three places:
  `checks.*`, other outputs (`tests` vs `testsError`), and devshell commands or apps the workflow runs.
- Run every test output and every enforcer suite explicitly; never infer them from a flake check.
- Never use grep to answer "does this flake expose X".
- Use relative flake refs only from the right cwd; prefer absolute paths.
- Write "green under `nix flake check ./ci`", never bare "green".

Related: \[[check-output-is-not-its-population]\] \[[nix-unit-collection-traps]\] \[[repo-has-more-than-one-lock]\] \[[formatter-check-is-not-a-format-run]\]
