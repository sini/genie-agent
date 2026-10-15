---
name: nix-regex-traps
description: When Nix code uses builtins.match, lib.hasInfix, or translates foreign regexes
type: trap
verified: 2026-10-15; Nix 2.34.8, Determinate Nix 3.23.1, Lix 2.95.3
---

**Rule:** `builtins.match` is POSIX ERE, full-string anchored and backtracking. Never run `.*x.*` over large strings, never pass it untranslated foreign regexes, and never expect `tryEval` to catch its errors.

**Why / measured:**

- `lib.hasInfix` is `builtins.match ".*${infix}.*"`. Run over a whole read-in source file of 15–18 KB inside a purity test, it makes libstdc++ `std::regex` backtrack to a depth proportional to the string length. The result was `stack overflow (possible infinite recursion)` under nix-unit only: nix-unit forces each expression from deeper in its own C++ stack, while a plain eval had headroom. An ecosystem had set `ulimit -s unlimited` everywhere to mask it. Bisection isolated string length, not nesting depth.
- Red herring: the overflow was reported under an alphabetically earlier suite, because output is printed in name order.
- Kubernetes CRD `pattern` fields are ECMAScript regex. Escapes like `\d \s \w \/ \] \} \- \:` fail to compile under POSIX ERE, and an invalid regex aborts the whole evaluation at compile time. `tryEval` cannot catch it.
- `.` in `builtins.match` does span newlines. A rationale saying otherwise is false even when the code happens to be right.
- `replaceStrings` is blind to regex context. Translating `[\w.-]+` to `[[0-9A-Za-z_].-]+` produced a pattern that rejected `my-app.v2`, and a nested `[[:]` opened POSIX class syntax and crashed.
- Nix double-quoted strings eat one backslash. A probe needs `"\\d"` to test the regex `\d`.

**How to apply:**

- Substring test: `builtins.length (lib.splitString tok s) > 1`, or a `split (escapeRegex tok)`-based `hasInfix`. Both are linear with no backtracking. Then remove any `ulimit` workarounds.
- For a foreign pattern, build an allow-list by peeling: translate the simple escapes, and apply the check only if no `[`, `{`, `(?` or leftover backslash remains. Otherwise skip the check and let the authoritative validator handle it.
- Pin the behaviour with regression tests that include the patterns that used to crash.

Related: \[[nix-tryeval-and-equality]\] \[[nix-unit-collection-traps]\]
