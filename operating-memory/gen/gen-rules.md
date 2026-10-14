---
name: gen-rules
description: Working in gen-rules, the framework-stratum library holding gen's only closure crossing (defunctionalization, the apply door, rule patterns).
type: reference
---

**Purpose:** gen-rules holds **the only place in gen where a closure is crossed**. A framework's loader
lowers closures into door nodes and door rules (`defunctionalize`), and one door applies a registered
closure at a context (`mkApply`). It also carries a small catalogue of rule patterns
(`conditionalEdge`, `abnormality`). This keeps the rest of the graph framework first-order data:
policies and guards become registered entries, not opaque Nix lambdas.

**Depends on:** gen-algebra (terms, `refId`), gen-identity (minting), gen-program (grounding),
gen-merge (the registration table is a module-system option), gen-aspects (guards). These five are the
root's only inputs, and `follows` puts them all on one substrate.
**Used by:** the gen hub (applies it through its substrate), gen-demo, framework authors.

**Not this library's job:** holding and firing guards (gen-aspects, via `cnf.ref`); grounding and firing
rules (gen-program `groundInstances`, which takes the door as `door`); the rule-contract row table
(gen-program `codomainBreaches`); solving (gen-scope); the term algebra (gen-algebra); minting
(gen-identity).

## Layout

| file                           | holds                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/defunctionalize.nix`      | `defunctionalize` (loader lowering), `lambdas` (the table option), `lambdasMount`                                                                                      |
| `lib/walk.nix`                 | the one traversal shared by loader and door, returns `{ value; found; bad; }` (three lazy fields over one child walk); `registrations`; the pattern reader `patternOf` |
| `lib/apply.nix`                | `mkApply`, the door, and its refusals                                                                                                                                  |
| `lib/catalogue.nix`            | `conditionalEdge`, `abnormality`, and the pattern contract                                                                                                             |
| `ci/tests/_fixtures/world.nix` | a complete minimal framework, the reference wiring                                                                                                                     |
| `ci/tests/surface.nix`         | asserts the export list                                                                                                                                                |

## API

`import ./lib { algebra; identity; aspects; program; merge; }`, each argument already applied. The flake
output is the root **published unapplied** (`lib = import ./.;`); the hub applies it. Exports:
`abnormality conditionalEdge defunctionalize lambdas lambdasMount mkApply registrations`.

- `defunctionalize`: lower each admitted module at the loader, given `aspectPaths` and `rulePaths`.
- `lambdas` / `lambdasMount`: declare the registration table / mount it inside each aspect.
- `registrations`: enumerate every registration (a read).
- `mkApply { lambdas; cnf; declared; }`: the door. Formals receive their formals; an open pattern
  receives the domain `D`, narrowed to `E`. Two codomain contracts: guard and rule. Nested closures get
  their own identifiers.
- `conditionalEdge`, `abnormality`: rule patterns (McCarthy's abnormality pair; an absent atom is FALSE
  in the well-founded model).

## Invariants

- The flake output stays **unapplied**. An applied output aborts every hub evaluation with
  `attempt to call something which is not a function but a set`.
- An aspect's attribute *set* never depends on a class value. A lifted class key keeps its name with
  value `{ }`, and an aspect with a class key always carries `includes`.
- A pattern is one record, every field checked by name, conditions as terms, gen-program declarations
  out, nothing evaluated.

## Working in it

- Tests: `nix develop ./ci --command ci` and `nix develop ./ci --command ci --tests-error` (refusal
  messages in `ci/tests-error.nix`).
- **Wire a framework:** mount `lambdas`; pass every admitted module through `defunctionalize`; build
  `mkApply { lambdas = <merged>; cnf; declared; }`; hand it to gen-aspects as `cnf.ref` and to
  gen-program's `groundInstances` as `door`. Copy `ci/tests/_fixtures/world.nix`.
- **Add a refusal:** return `refuse "<code>" { …; message; }` from `mkApply`; add a cell reading its
  code in `ci/tests/door.nix`; name the plant that removes the refusal.
- **Add a pattern:** follow the contract in `lib/catalogue.nix` and add a gen-demo declaration.

## Traps

- `builtins.fromJSON` aborts **uncatchably** on malformed input, and `builtins.match` overflows the C++
  stack on a long subject. The door bounds the length (8192) and matches the whole `refId` grammar before
  any decode. A prefix match aborts on `{"declared":`.
- Removing a lifted class key made `attrNames` force every class value. Keep the key.
- A `#` inside a string literal blinds the purity scan's comment strip, so the inline-import key
  separator is spelled by its code point.
- A top-level module function is wrapped by its formals, so gen-merge must apply a functor module by its
  published formals; otherwise it aborts with `called without required argument 'pkgs'`.

Theory: Reynolds 1972 (defunctionalization, the single `apply`); Przymusinski 1988 (abnormality,
well-founded semantics).
