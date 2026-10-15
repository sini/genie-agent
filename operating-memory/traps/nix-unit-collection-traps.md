---
name: nix-unit-collection-traps
description: When selecting, naming, adding or counting nix-unit tests, tallying nix-unit output, or mixing nix-unit with a homegrown checks asserter
type: trap
verified: 2026-10-15; nix-unit 2.35.1
---

**Rule:** nix-unit collects a test only if its attribute name starts with `test`. Record the suite total
before adding N cells and confirm it grows by exactly N; a green whose denominator did not grow
measured nothing you wrote. Tally failures from a whole capture, never from glyphs you sliced.

**Why / measured (collection):**

- The endpoint of the target attrpath is always treated as a group. `nix-unit --flake .#tests.<suite>.<test>`
  pointed at a bare `{ expr; expected; }` leaf finds no `test`-prefixed children and prints `0/0 successful`. Selecting a single test silently passes and runs nothing. In one project the test
  command's help text advertised exactly that form.
- A suite reported 28/28 green while all 13 of its `control-*` cells were never collected. Renamed
  `test-control-*`: 41/41. A control that does not run turns every absence claim into a dead predicate.
- A brand-new untracked test file does not exist to a git-filtered flake source. Reported baselines
  203/203 and 397/397 never evaluated it; after `git add`, 211/211 and 405/405 (+8, the declared
  cells). Caught only because a deliberate RED reddened where the file was already tracked. See
  \[[nix-flake-filtered-tree-and-eval-cache]\].
- The reverse: a global gitignore silently EATS a file a probe expected (reported as an eval error).
- An aggregate repo that publishes no `#tests` output gives 0/0 when nix-unit is aimed at it.
- A homegrown `checks.default` asserter comparing only `expr == expected` crashes the whole check
  build on an `expectedError` test, because the throw reaches top level. `(builtins.tryEval e).success == false` is portable but blind to the message, so a guard can pass while throwing for the wrong reason.

**Why / measured (tallying):** failures and errors are marked with multi-byte emoji (a red cross; a
radioactive sign, which is TWO codepoints, U+2622 U+FE0F).

- A fixed-width `cut`/`sed` added for readability sliced the glyph mid-codepoint, so it matched neither
  grep and a red run tallied clean. `cat -v` told it apart from ANSI codes.
- Nix error traces QUOTE nearby source lines. A test comment containing the failure glyph was printed
  whenever a nearby cell errored: a true "0 failed, 2 errored" read "2 failed", and the collected-cell
  count moved 105 -> 107, corrupting the "collected == declared" guard.
- Over one file: `grep -c` gave 3 and 1 (lines); `grep -oE` gave 4 and 4 (occurrences).

**How to apply:**

- Name every cell, controls included, `test-*`. Select one test by wrapping the leaf in a fresh group
  (`{ <test> = leaf; }`), or run the whole suite.
- `git add` new test files BEFORE you measure; use a wrapper that refuses on git-unknown files under
  the read roots. `git check-ignore -v <file>` when an expected file is missing.
- Drive a RED arm on new cells; a green over an absent file equals a green over a passing one.
- Keep error-plane tests in a separate output and run both planes.
- `nix-unit --flake ./ci#tests > out.txt 2>&1; echo "rc=$?"`, then count on `out.txt`. Say LINES or
  OCCURRENCES and which codepoint sequence. Slice only on line boundaries; prove a known-red cell
  still tallies in the same run.
- In test files write the words ("failure marker"), never the glyphs.

Related: \[[flake-check-running-zero]\] \[[nix-which-flake-which-output]\] \[[stderr-token-control-false-fires]\] \[[nix-tryeval-and-equality]\] \[[assert-which-refusal-fired]\]
