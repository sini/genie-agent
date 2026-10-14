---
name: gen-pipe
description: gen-pipe is ARCHIVED (scoped dataflow channels); read this before touching it, or when porting a caller to gen-view / gen-select.
type: reference
---

**Status: ARCHIVED. Do not bind it.** gen-pipe retired into the "movement vocabulary": it is off the hub
roster and is not a hub input. The repository is orphaned for reference; nothing is maintained. It had
zero external code consumers when it retired.

- Bind **gen-view** for the dataflow constructs. Twelve of its 17 exports map to named gen-view
  constructs: `channel map filter fold scan over route tee compose run provenanceOf traceOf`.
- Bind **gen-select** directly for `sel` (gen-pipe only re-exported it).
- `join` has no single replacement: write the fan-in as a caller-side composition.
- `consume` is split; `contribute` and `deferred` are HELD until their destinations exist.
- The per-export map is in the repository's `REFERENCE.md`.

**Retirement pattern worth reusing:** the surface is MARKED, never cut. Every export still evaluates
and the suite stays green, because cutting retired exports would leave the held ones with no fixtures.
The only admissible ground for removal is "serviced elsewhere"; a caller count is not one. The drift
check proves the retirement changed the documentation and not the surface: the pinned export list diffs
clean, and a one-token mutant of the same list goes red.

**Known broken, deliberately unfixed:** the root shim's no-argument defaults (`import ./. { }`) yield a
lambda for `select` and throw for `scope`. Fixing them would be investment against the retirement ruling.

**What it was:** scoped channels plus a dataflow algebra. A channel's value at a scope position is a left
fold over the contributions visible from that position under a pinned traversal. `map`, `filter`, `fold`,
`scan`, `over`, `route`, `join` and `tee` wire channels into a DAG; `compose` validates it (using
gen-graph `topoOrder`) and `run` evaluates it demand-driven against a caller traversal adapter
`{ order; contributionsAt; render ?; resolveDeferred ?; }`. `import ./lib { prelude, select, graph, scope ? null }`.
Errors are coded `gen-pipe[E1..E11]`.

**Lessons from its traps that transfer to gen-view and other designs:**

- A derived name equal to a declared name was silently discarded; the duplicate-name check did not fire.
  Two different derivations of the same op over the same input collapsed, dropping a predicate. Require a
  disambiguating `site` key.
- `compose` cost was CUBIC in channel count once any derive edge existed. Measure with `NIX_SHOW_STATS`
  (`nrFunctionCalls`) over a growing chain before trusting a combinator's cost.
- `run` never applied the channel's type contract; only `consume` did. `consume` returned one entry per
  contribution without applying `combine`. Know which read applies which contract.
- Forcing `.value` before `.class` masked an E1 ambiguity error behind E6. Error precedence follows force order.
- A hard-coded two-name probe (`config`, `osConfig`) let a differently named argument pass as plain data.
- `join`'s `combine` had to be a record `{ f; init; }`; a bare function was an uncaught Nix type error.
- `select = null` delivered everything. `merge = "semilattice-set"` silently installed a dedup.
- `outputs.at p` re-read `contributionsAt` 4x per channel when the whole record was forced.
- A null `producer.entity` made selectors silently false instead of throwing.
- Multiple writers per channel break Kahn's single-writer condition, so its determinism had to come from
  a pinned traversal order, not from KPN semantics.

**Working in it (only to read it):** `nix flake check ./ci`. Drift: `nix eval --json .#lib --apply 'l: { top = builtins.attrNames l; sel = builtins.attrNames l.sel; }'`.
