---
name: reading-test-suite-output
description: When running, quoting or gating on a test command (nix-unit, flake check, just recipes), especially under zsh, and deciding whether a run was green
type: practice
---

**Rule:** Verify the runner before quoting a command, capture `2>&1` and the exit status
unpiped (only commit after seeing `exit=0`), and compare the collected count against the baseline you carried in. A green
summary and a zero failure count are not evidence on their own.

**Why (measured):**

- **A piped gate passes a red.** `nix-unit ... | tail -2 && git commit && git push` used `tail`'s
  status, 0: a failing suite committed and pushed a broken change to a public repo. The bash
  workaround `${PIPESTATUS[0]}` is EMPTY under zsh (zsh spells it `$pipestatus`), and empty reads as
  success.
- **nix-unit moves its markers between streams depending on the outcome.** On a passing run,
  the ticks and `🎉 217/217` are on stdout and stderr is 0 bytes. On a failing run, stdout holds
  213 ticks with no ❌ and no summary, and stderr holds the ❌ lines and `213/217`. A
  stdout-only pipeline sees a failing run as success.
- **Three markers:** ✅, ❌ (mismatch) and ☢️ (evaluation error). A ❌-only grep undercounts.
- **A crashed run** looked like: exit 1, no summary line, zero ❌, zero ☢️, zero bytes of
  stderr, and 911 of 1153 cells collected. The only tells were the missing summary and the
  short count.
- **`N/N` can be an identity, not a check.** One runner computes `total = pass + fail`, so
  the two numbers match on any run that reaches the summary, including a truncated one.
- **Never grep the diff renderer for a value.** It wraps values across padded columns, so
  both arms read 0. Assert the value as a cell and read ✅/❌.
- **A non-git copy of a test flake escapes its root.** Every gen-\* library's `ci/flake.nix` imports `../lib`; under
  a non-git path flake the root resolves to `ci/` and the import points elsewhere. Readings of
  15/864 and 7/486 were reported as catastrophic reds. Only the unmutated stock arm, which
  showed the identical 7/486, exposed it.
- **Repositories may have several test planes** (tests, error goldens, per-process cells).
  In gen-merge, `ci` alone read 816/816 while `ci --tests-error` read 328/471, and a build that
  ran two of three planes (missing `--tests-process`) landed a red main.
- **A recipe-listing grep missed parameterized `just` recipes** (`ci test="" *args:` has no
  colon after the name), and it reported real recipes as absent. Use `just -l` inside the
  devshell.

**How to apply:**

- Read the command from the repository's README and CI workflow, and list the test planes
  from the runner's own help. Every oracle names ALL planes.

- `cmd > out 2>&1; echo "exit=$?"` and then `tail -1 out`; never chain `&&` off a piped verify. Count ✅, ❌ and ☢️, and compare the
  collected total to the expected baseline.

- A red you cannot also produce on an unpatched copy of the same revision is not a finding.
  Prefer "my instrument moved" over "the library collapsed".

- Measure in the real checkout. If you must use a copy, `git init` it or address it as
  `git+file://<path>?dir=ci`.

- Untracked files are invisible to flake evaluation. Use a guarded runner that refuses on
  git-unknown files, or `git add` first.

- A reviewer's "this field is dead/unread" is a hypothesis (a library may consume it internally);
  the gated suite run is the verification, so it has to actually gate.

Related: \[[ci-gate-discipline]\] \[[armed-controls]\] \[[success-signal-is-not-measurement]\]
