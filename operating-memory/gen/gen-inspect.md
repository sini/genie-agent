---
name: gen-inspect
description: Working in gen-inspect, the read-only interrogator of a materialized gen graph (SQL-like queries, why-provenance, rendering).
type: reference
verified: unverified
---

**Purpose:** interrogate a MATERIALIZED gen graph: which nodes exist and of what kind, which edges are
declared, which a rule program produced and WHY, and what reaches what. It implements no semantics
and NEVER evaluates: every fixpoint goes through gen-scope, the sole evaluator. It reads a model an
evaluator already produced, which makes conformance true by construction.

**Depends on / used by:** injected values gen-prelude, gen-graph, gen-select, gen-scope, and gen-program
(APPLIED). It re-exports none of them. Applied by the hub through its substrate fold.

**Layout (`lib/`):**

- `materialize.nix`: the IR contract and its one construction. Builds `origin` from the subject's
  declarations x `model.verdict` (gen-scope's `provenance` is a condensation-depth stamp, not per-atom
  provenance). Rule edges come from gen-program `(ruleEdges model declarations).reached`. Holds the
  missing-field, unrepresented-edge and mint doors.
- `extras.nix`: gen-prelude plus seven names the copied parser needs (NOT nixpkgs `lib`).
- `sql.nix`, `executor.nix`: COPIES of gen-scope's SQL example, each with an origin header. Examples
  are not published surface, and a second root input to reach one is forbidden.
- `compile.nix`: the program route (`reaches` grounded per FROM/JOIN occurrence, solved on gen-scope),
  `why` (one-step body-checked witnesses), and the permanent path-enumeration refusal.
- `door.nix`: refusals for unknown table/column/label/kind/`via`/`src`/qualifier.
- `select.nix`, `render.nix` (mermaid, dot, JSON; reads the IR, never the scope), `inspector.nix`.

**API:** `import ./lib { prelude, graph, select, scope, program }`. The flake publishes the root UNAPPLIED
(`lib = import ./.;`); an applied output aborts every hub evaluation with "attempt to call something
which is not a function but a set". Exports: `astToSelector compile door evalQuery fromGraph graphSubject materialize mkInspector parseSql render reservedNames select tokenize`.

- Argument order: options first and closed, configuration next, subject last.
  `graphSubject { kind ? "vertex"; } { nodes; perLabel; }` and `fromGraph` are the only record doors;
  the graph record is open but refuses `kind` by name. Others are positional: `compile ast ir`,
  `door ast ir`, `evalQuery ast tables`, `select genSelect selector ir`, `parseSql text`, `render.<fmt> ir`.
- `mkInspector subject -> { facts, select, query, parse, render, why }`.

**Invariants and laws:**

- The dynamic label set is the declarations' own labels, never a literal list. A hand-kept list drops
  every derived edge whose label is missing, at exit 0. The `unrepresented` door catches it.
- A witness is BODY-checked, never head-matched (Van Gelder, Ross & Schlipf 1991). A head match reports
  a rule whose body is false as `fired`. One construction, `witnesses`, serves both rule and query programs.
- `reaches` pushdown is PER OCCURRENCE and only prunes. Joined rows merge `left // right`, so an
  unqualified column binds right; grounding one table for all occurrences answers wrong at exit 0.
  Parity cells (pruned = unpruned) guard it.
- `reaches` relata domain = node ids UNION every edge endpoint, used for both the frozen set and the `dst` domain.
- A recursion test needs a depth >= 2 question; depth-1 questions pass against a non-recursive route.
- `origins` is an IR FIELD (must survive `select` and `compile`); `derivations` is a LIST; `fired` carries
  negative literals (needed for why-not).
- Use `deepSeq`, not `seq`, in a door; `seq` on a list checks nothing past WHNF. Force the whole IR in a
  test, never `length` it (that forces only the spine).
- No nixpkgs `lib`; no host-framework vocabulary at kind/label/option/error position (position-scoped,
  comment-stripped scan; a bare word sweep false-positives on English prose).
- One edge list: rule edges join `declaredEdges ++ ruleEdges`, told apart by `origin`, never stored apart.
- `origins` is why-provenance only; the provenance semiring is deliberately not realized.

**Dependency pattern:** a member depending on an UNAPPLIED member takes it applied, and its shim
default names its sibling formals:
`program ? inputs.gen-program or (import (src [ "gen-program" ]) { inherit prelude scope; })`. A bare
`import (src segs) { }` would self-fetch a second gen-scope instance into one evaluation.

**Working in it:**

- `nix develop ./ci --command ci` and `... ci --tests-error` (guarded). Unguarded: `nix flake check ./ci`,
  `nix-unit --flake ./ci#tests`, `nix-unit --flake ./ci#testsError`. Format: `cd ci && nix fmt -- --ci`.
- Read the asserter's own count, not nix-unit's: nix-unit collects only `test`-prefixed attrs.
- Run BOTH nix-unit planes; `#tests` alone omits every by-name refusal cell and reads clean.
- `ci/flake.lock` must pin gen-harness at the same revision the whole roster pins: the hub's pin-coherence
  check uses gen-harness as its live positive control.
- `ci/` declares no hub input (the hub pins this repo; that would be a cycle).
