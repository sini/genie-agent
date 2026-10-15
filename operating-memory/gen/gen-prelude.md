---
name: gen-prelude
description: Working in gen-prelude, the zero-dependency utility base of the gen ecosystem (builtins aliases, vendored nixpkgs.lib helpers, the door/refusal constructs).
type: reference
verified: unverified
---

**Purpose:** the utility base every pure gen library stands on: `builtins` re-exports plus the pure
list/attrset/string helpers the substrate uses, vendored behaviour-identically from `nixpkgs.lib`, so
other gen libraries can drop `nixpkgs.lib` from their closure. It also owns the DOOR constructs: the
shared way every gen library checks options and refuses by name.

**Depends on / used by:** ZERO inputs, so adding it adds nothing to a consumer's lock. Purity is
structural (no nixpkgs in scope), not test-enforced. Used by nearly every gen library; bound as
`prelude` by the hub.

**Not its job:** type checking (gen-types), module merge and `mkIf`/`mkDefault` (gen-merge), records and
`either` (gen-algebra), identity minting (gen-identity), ANY topological ordering (gen-graph `topoOrder`;
only primitive `sort` stays here), channels (gen-view), graph products (gen-product). `hasSuffix`,
`removeSuffix`, `zipAttrsWith`, `concatStrings` have no gen owner at all; add them only when a caller needs them.

**Layout:** `lib/default.nix` (everything), root `default.nix` (nullary: `import ./. { }`), tests in
`ci/tests/prelude.nix` (literal expectations for originals), the `prelude-fidelity` suite (vendored
functions equal to `lib.X` on the same inputs), `ci/tests/door.nix`, `ci/tests/door-constructor.nix`.

**API:** `inputs.gen-prelude.lib`; `import ./lib` is a bare VALUE, not a function. The namespace is flat.

- builtins aliases: `all any attrNames attrValues concatLists concatMap concatStringsSep elem elemAt filter foldl' genList groupBy head isAttrs isList length listToAttrs map mapAttrs match partition sort stringLength substring tail`.
- `isFunction` and `functionArgs` are nixpkgs' FUNCTOR-AWARE versions, not builtins. `builtins.isFunction`
  reads a door as `false`, and `builtins.functionArgs` on a door aborts past `tryEval`.
- Vendored: `genAttrs nameValuePair filterAttrs mapAttrsToList optional optionalAttrs optionalString last init setAttrByPath getAttrByPath unique findFirst imap0 range max fix concatMapStringsSep hasPrefix removePrefix isStringLike hasInfix escapeRegex`.
- Originals: `indexOf list x` (LIST FIRST, -1 if absent), `dedupByKey keyFn list` (first wins; `null` keys
  always kept), `iterateBounded strict step init bound`, `renderValue` (total rendering of a value inside
  a refusal message), `checkOptions door names opts` (CLOSED set), `checkRequired door names record` (OPEN
  record: missing refused, extras admitted), `checkGuarded`, `refusals` (the refusal texts as functions).
- `door { name; required ? []; optional ? []; open ? false; optionsStep ? null; next ? null; } body`:
  a functor publishing `__contract` and derived `__functionArgs`, checking at its own application
  (`let a = check args; in seq a (body a)`, never the lazy `body (check args)`).
- `resolve { hint ? ; form ? ; } { entries; isCanonical; } door ref -> id`: a reference to its identifier;
  nothing is minted.

**Invariants and laws:**

- Vendored functions are held `==` to `nixpkgs.lib` on values by `prelude-fidelity`. Error STRINGS may
  differ (`gen-prelude.last: list must not be empty`). `getAttrByPath` keeps the old nixpkgs name on purpose.
- Every door refusal reads `<door>: ... (in prelude.<construct>)` and is a catchable `throw` of
  `refusals.<n> ...`. Downstream tests build expected messages through `refusals`, never by pinning wording.
- Options-first, closed options; open data records; a mixed door composes
  `checkOptions door (req ++ opt) (checkRequired door req args)`.
- No Nix-level recursion proportional to input size: loops are primop tables or `iterateBounded`.

**Working in it:** `nix develop ./ci --command ci` (guarded), `nix flake check ./ci` (CI), `nix fmt -- --ci`.
Drift: `nix eval --json .#lib --apply builtins.attrNames`, plus `.#lib.refusals` for the one nested record.

**Traps:**

- `hasInfix` exists because nixpkgs' `.*needle.*` regex recurses to a depth proportional to the haystack and
  overflows the C stack on large strings (e.g. a read source file). Its implementation is split-based and linear.
  `hasInfix "" s` is always `true`.
- `escapeRegex` uses nixpkgs' twelve metacharacters verbatim: it escapes `{` but not `}` or `-`. `]` is
  deliberately absent, because `\]` is a rejected pattern and the abort escapes `tryEval`. Over-escaping is
  as wrong as under-escaping. Test the escape set per member, one drop at a time.
- `iterateBounded`'s `strict` argument is load-bearing: `foldl'` forces only WHNF, so un-named record fields
  build a thunk chain that overflows on the final force, under a different error signature. Exception: a
  field the step's own guard reads each iteration stays one deep.
- `iterateBounded` exists because a self-applying loop spends one frame per iteration, and its abort at
  `max-call-depth` cannot be caught. Bounded iteration ran 20,000 steps, twice the default depth.
- `unique` costs two variables: strings take a linear table; other types are quadratic in the DISTINCT count.
  It compares structurally, so equal attrsets collapse.
- A non-string, non-null `dedupByKey` key and a swapped `indexOf` are interpreter type errors that `tryEval`
  cannot catch.
- `findFirst` walks every index but does not force elements past the match.
- `toposort` is gone (it was quadratic); ordering is gen-graph's. The absence is asserted with `p ? sort` as control.
- `tryEval` drops the message, so a cell can only see THAT something refused, never WHY. Check named-refusal
  text with shell arms that read stderr; otherwise a build throwing the wrong message passes.
- `replaceStrings` and `split` are used internally but not re-exported. `groupBy` is the primop, with no fidelity arm.
