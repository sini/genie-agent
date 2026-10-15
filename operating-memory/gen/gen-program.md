---
name: gen-program
description: Working in gen-program, which turns framework declarations into a logic program, drives gen-scope's well-founded engine per pass, and carries the third value (T/P/U) out.
type: reference
verified: unverified
---

**Purpose:** the consumer that turns a framework's declarations into a **logic program**, drives
gen-scope's well-founded engine over it once per pass, and carries the three-valued result out under
its own name. This is where "policies are logic programs producing dynamic edges" becomes concrete:
labelled heads become graph edges (`ruleEdges`), promoted heads become nodes. It implements **no
semantics**: the semantics is gen-scope's (well-founded model, three values). What lives here is the
translation, the pass-boundary construction, coherence adjudication, the policy-body algebra, and the call.

**Depends on:** gen-prelude, gen-scope (`mkRule`, `engine.solve`, `leastModel`), gen-algebra (terms,
`checkClause`, `refId`), gen-identity (`hashIdentity`). Inputs are declared, never applied: the root is
published unapplied, and only plain data crosses a gen-to-gen boundary.
**Used by:** gen-rules (the door feeds `groundInstances`; it reads `codomainBreaches`), the hub, gen-demo.
**Not its job:** the stratification driver and the solver (gen-scope), minting identity (one authority),
query surfaces or materialization (gen-view), re-exporting gen-scope constructs.

## API (`import ./lib { prelude; scope; algebra; identity; }`)

- `declaration { pos?; neg?; label?; promote?; when?; } relata head`. No body means a FACT. `label`
  names the edge the head denotes; `promote` (a relation kind) makes the head a NODE with labelled-tuple
  relata. `when` is the literal tier: `has a` to `pos`, `not (has a)` to `neg`, `all` conjoins; `any`,
  `eq`, and functions are refused, and `when` beside `pos`/`neg` is refused.
- `rule decl`; `program frozen declarations` (refuses a relatum no earlier pass settled);
  `unresolvedRelata` (that refusal's content as data, because `tryEval` discards messages).
- `model { program; interpretation; complete; prior; }` (all required): solves this pass from scratch.
  `prior` is the omission guard: refuses when a prior rule is missing. A first pass states
  `prior = null`. `interpretation` is a list of `{ atom; verdict; }` assertions for this pass only.
- The result record: `trueAtoms withheldAtoms undefinedAtoms falseAtoms` (partition program atoms plus
  asserted ones), `verdict`, `resolve`, `adjudication`, `complete`, `converged`, `provenance`,
  `condensationDepth`, and `rules` (keyed by the JSON of each canonical rule, sorted and deduped).
- `ruleEdges model decls -> { candidates; reached; promotions; promoted; }`; `mkModel` (its `__contract`
  lists required fields).
- `flagNames`/`flags`: van Antwerpen's `T`/`P`/`U`. `adjudicate { program; model; interpretation; }`,
  `stableModelCriterion`, `adjudicationOutcomes` (`admitted refused not-evaluated`), `stableModelBudget`
  (a derived figure with its derivation, never a bare number).
- Policy-body algebra: `body { name; clauses; declared; }` (`declared` is required; `null` = open
  world), `emit`, `forEach { over; emit; }`, door clauses `{ when?; body = ref r; emits; binds; suppresses; }`, `ctorNames` (`member deliver edge suppress realize`), `deriveCodomain` (takes no
  context, which proves no fact depends on firing context), `groundInstances { door ? null; sources ? {}; } context body`, `codomainBreaches contract decls`, `admit`. `escape`/`fireEscape` are retired
  aliases that refuse, naming the gen-rules door.

## Invariants

- `resolve` is total and every answer carries its flag. `T`: closed relation, two-valued. `P` on a
  growing relation: `included = true` only for atoms derived with **negation-free** support
  (transitively); otherwise it **refuses by name**. `U`: refuses. Withheld answers are **fields that
  throw**, never absent or `null`, because every `if r.included` reads `null` as false: the silent
  collapse.
- Every missing-field refusal is **catchable**, by the door's name. Every operand a door reads is
  checked where read. Two stated exceptions: closures you hand over (`verdict`, `resolve`) can abort when
  read, and `groundInstances` context keys are an open world (an option put in the context is silently
  read as a coordinate; options go in the first argument).
- Policy-body refusals are **values** (`{ refused = true; code; blamed; witness; message; }`), not throws.
  Every free slot is a gen-algebra term; a function there is refused.
- Adjudication is polynomial on the normal path: a total well-founded model *is* the unique stable model.
  A partial one searches exhaustively within budget; beyond it the answer is `not-evaluated`, an
  absence, never an admission.
- Prior verdicts cross as an **interpretation**, not as compiled rules. Compiling them into rules
  ("carried" partner atoms) made a program with **no** stable model acquire one at the boundary
  (`p :- not p` went from refused to admitted). "Only adds stable models" does not preserve refusal:
  adding to zero gives more than zero.
- The library claims the pass construction, **not** a compositional theorem. Relaxing the input-type
  discipline (letting a query result decide an edge's existence) would make cycles writable, and the
  failure would be silent.
- Names must resolve at the primary they cite. `program` and `rule` occur in both cited papers;
  `stratum` and `well-founded model` occur in only one each, so they live in gen-scope. No identifier
  uses `policy` (four-way overloaded). The test asserts the absence with a positive control.

## Working in it

```sh
nix develop ./ci --command ci                # guarded
nix develop ./ci --command ci --tests-error  # error-message cells, guarded
nix-unit --flake ./ci#tests                  # unguarded
cd ci && nix fmt -- --ci                     # from the main checkout, never a linked worktree
```

- Count **both** failure and error markers in nix-unit output; zero failures with some errors has not passed.
- A value cell lives at `flake.tests.<suite>.<cell>`. A cell placed directly under `flake.tests` passes
  nix-unit and then crashes `nix flake check` ("expected a set but found a list"). `testsError` is flat.
- `nix fmt -- --ci` rewrites the tree, so a second run is green regardless. `git add` new files before
  formatting (treefmt cannot see untracked files) and again after.
- Drift check: the flake `lib` is a function, so use
  `nix eval --json --impure --file ci/repl.nix --apply 'r: builtins.attrNames r.genProgram'`.

## Traps

- A measurement of term occurrence must name its predicate (case sensitivity, occurrences vs lines,
  transcription-only, with a live and a negative control). Ligature damage in paper transcriptions is
  per-term, so sweep both spellings (`stratified`, `strati ed`).
- A scan per rule over a list is quadratic at thousands of rules, and evaluator counters cannot see it;
  the test asserts the index structure instead.
- `complete = true` is the caller's claim that nothing more can arrive; no default exists, because a
  defaulted `true` would silently close the sequence.

Theory: Apt–Blair–Walker 1988 (stratification), Van Gelder–Ross–Schlipf 1991 (well-founded model;
Cor. 5.6/5.7 bound adjudication), van Antwerpen et al. 2016/2018 (T/P/U flags, delayed queries).
