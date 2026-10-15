---
name: gen-dispatch
description: Working in or calling gen-dispatch — one relational guard→effect dispatch step over ordered groups (rules, conflict resolution, opaque actions).
type: reference
---

**Purpose:** relational rule dispatch as ONE guard→effect STEP. `dispatch` walks a caller-supplied
`groupOrder`; per group it matches rule conditions against a threaded context, resolves conflicts
(override → priority → exclusive), fires the survivors, and buckets their opaque actions by group.
It never sorts groups and never loops: the order comes from gen-graph's `phaseOrder` and the
fixpoint loop from gen-scope's `circular`. Step, loop and order are separate concerns.

**Depends on / used by:** gen-prelude is the sole runtime dependency (gen-algebra is a removed,
dead input; gen-select is CI-only). Used by policy and framework layers. NOT its job: the
convergence loop (gen-scope), building `groupOrder` (gen-graph), selector evaluation (gen-select),
minting identity (a rule `identity` is a caller-supplied bare string), the MEANING of actions (the
consumer; gen-dispatch reads only `__action`).

## Layout

- `lib/core/rule.nix` — `mkRule`, `fromFunction`, `fromFunctionMatch`, `identityOf`, `taggedHandle`.
- `lib/core/actions.nix` — `mkActions`. `lib/core/dispatch.nix` — `dispatch`.
- `lib/core/compose.nix` — `restrict`, `override`, `chain`. `lib/core/declared.nix` — static stratum.
- `lib/adapters/select.nix` — gen-select adapter.
- `default.nix` — function with formal `prelude` (default from `ci/flake.lock`) plus `wire`; no `...`.

## API

- `mkRule { nac; identity; priority ? 0; overrides ? []; group; produces; } condition produce` →
  rule `{ condition; group; identity; nac; overrides; priority; produce; produces; }`. Options are a
  closed set, first.
- `fromFunction fn` — condition = `builtins.functionArgs fn`; pair with `match = fromFunctionMatch`.
- `mkActions { <group> = [ tag ]; }` → constructors `<tag> = args -> { __action = tag; } // args`,
  plus `classify` (action → group) and `groupOfKind` (tag → group).
- `dispatch { } { rules; id; context; match; classify; groupOrder; exclusive ? false; extract ? (_: {}); combine ? (ctx: _: ctx); }` → `{ actions; orderedGroups; context; }`. `actions` holds only
  non-empty groups; `orderedGroups` is the present-only subsequence.
- `restrict extraCondition rule`, `override { original; replacement; }`, `chain extract ruleA ruleB`.
- `groupOf`, `producesOf` (read a rule's stratum without firing it), `deriveGroup groupOfKind rule`.
- `adapters.select.mkMatch genSelect`, `adapters.select.selectorSpecificity`.

## Invariants and laws

- **Stratified groups (Datafun):** every rule in group N completes before group N+1, with context
  threaded between. The stratum is a STATIC property: classify declared `produces` without running
  the body.
- **Negative application conditions** (`nac`, from algebraic graph transformation) are evaluated
  before the condition.
- **Actions are opaque** tagged attrsets; meaning is the consumer's.
- **Identity by regime, not name:** `fromFunction` on an intensional value yields `"m:<digest>"`
  when minted, `null` when unmintable (a refusal), `"u:<name>"` when unmigrated; tags keep the arms
  disjoint so a name cannot forge a minted handle. Explicit identities passed to `mkRule` are verbatim.
- Equal-priority ties fire in declaration order (a total-order sort).
- It is a pure function of `(rules, context)` and re-evaluates every condition each call; it is NOT
  RETE (no compiled network, no cross-call state). RETE is cited for vocabulary only.

## Working in it

- `nix develop ./ci --command ci` and `nix develop ./ci --command ci --tests-error`; `nix flake check ./ci` is CI's unguarded form.
- Purity (`ci/tests/purity.nix`): depends only on gen-prelude; comment-stripped scan, so a comment
  naming a dead input does not trip it.
- Drift check: `nix eval --json .#lib --apply 'l: builtins.attrNames l'`.

## Traps

- Options are closed and refused by name; `dispatch`'s operand record is open but missing fields refuse.
- In `functionArgs` polarity, **`false` means REQUIRED**.
- A `groupOrder` of length ≤ 1 never consults `r.group` and skips cross-group validation: everything
  lands under that one name. `groupOrder = [ ]` fires nothing, silently.
- `extract` / `combine` default to NO threading: a cascade needs both or the downstream group never fires.
- Empty groups are ABSENT from `.actions`; read with `or [ ]`.
- Override suppression is forward only: a later group cannot suppress an earlier group's fired rule.
- `exclusive` keeps top priority per group, not globally.
- A rule with `produces != null` skips classify-validation and may emit foreign-group actions
  silently; `produces = [ ]` counts as declared while `deriveGroup` leaves `group = null`.
- `mkActions` reserves `classify` and `groupOfKind`: a tag with either name is silently shadowed.
  Constructor `args` can overwrite `__action`. `classify` on an untagged value throws uncatchably.
- A `chain` result is not a `mkRule` record (no `group`): multi-group dispatch fails with a raw
  missing-attribute error. Its identity is `null` if either arm is anonymous; `override` throws on an
  anonymous original. `restrict` prefixes identity with `restricted:`.
- `fromFunctionMatch` ignores `id` entirely: an id-conditional rule matches every id. `mkMatch` reads
  `id` but expects gen-select's five-accessor context, not the flat dispatch context.
- `mkMatch` unwraps only ONE `__restricted` level; `fromFunctionMatch` recurses.
- `selectorSpecificity` scores `entity` / `kind` / `coord` as 0, and `any` sums branches like `and`.
- CI's gen-select pin may be older than current gen-select; the adapter's tested surface is narrower.
- The repo was renamed from gen-derive. When grepping for residue of a rename, exclude the file that
  records the rename (it is tracked, so `git grep` sees it).

Related: \[[gen-overview]\] \[[gen-algebra]\] \[[gen-retired]\]
