---
name: gen-identity
description: Working in gen-identity, the gen ecosystem's single identity-minting authority (hashIdentity).
type: reference
---

**Purpose:** the ONE place in the gen ecosystem that mints an identity. `hashIdentity` turns a kind
tag, a label list and a value lookup into `"<kind>:<sha256hex>"` over a bounded, type-tagged,
canonical encoding of inert Nix values. In the graph framework, every entity node's identity comes
from here; nothing else mints. Reference-grade library: deleting anything needs a domain argument
(wrong abstraction, subsumed, unsound), never "nobody uses it".

**Depends on / used by:** zero dependencies of any kind. Called by gen-schema (identity-key
reflection and `id_hash` stamping live there, not here).

**Layout:**

- `lib/default.nix`: the whole library (`hashIdentity`, internal `canonicalEncode`, the bounds).
- `ci/tests/identity-encoding.nix`, `ci/tests/purity.nix`, `ci/tests/surface.nix`.

**API:** entry is `inputs.gen-identity.lib` or `import ./.`; a BARE attrset, not a function, so it
takes no dependency argument.

- `hashIdentity : kind -> [label] -> (label -> value) -> "<kind>:<sha256hex>"`. That is the whole surface.
- `canonicalEncode` (raw `depth -> budget -> value -> { s; b; }`) stays INTERNAL by decision: publishing
  it would hand callers the budget, a second refusal policy over one encoding. If a consumer ever needs
  an untagged encoding, publish a SATURATED `value -> string` under a different name, and only once a
  real caller exists to shape it.

**Not this library's job** (route these elsewhere): identity-key reflection and kinds (gen-schema,
`lib/id-hash.nix`); intensional identity of functions (gen-algebra); type checking (gen-types);
gate digests (gen-class: a digest is not an identity); aspect keys (gen-aspects `lib/identity.nix`);
binding identities (gen-bind `lib/identity.nix`); dedup/trace keys (gen-view `hashTrace`, gen-memo
`hashOf`). Three other files in the ecosystem are called `identity.nix`, and none is this library.
Writing that down stops every hashing question landing here.

**Invariants and laws:**

- `==` biconditional both ways: equal values mint equal ids, and unequal values mint different ids.
  Integral floats normalise to int, so `1 == 1.0` mints one id. That is deliberate. The float domain is strict.
- One minting authority: the substrate REFUSES an unencodable value instead of inventing an identity.
- Identity is structural through the mint; the domain is inert structure (no functions).
- Dependency-free: no nixpkgs, no module system, no substrate identifier (scanned over `lib/**.nix`,
  root `flake.nix`, `default.nix`, with a non-empty control and a live-predicate control).
- Sole export pinned by contents; a second name appearing is drift, not a fix.

**Working in it:**

- `nix develop ./ci --command ci` and `nix develop ./ci --command ci --tests-error` (guarded: refuse on
  untracked files under read roots). `nix flake check ./ci` is unguarded.
- Drift check: `nix eval --json .#lib --apply builtins.attrNames` must print `["hashIdentity"]`.

**Traps:**

- The mint FORCES its whole input; a lazily failing leaf fails at mint time, not at first read.
- A record whose `type` is `"derivation"` still mints unless it has `type` AND `drvPath` AND `outPath`.
  Testing `type` alone made admissibility depend on position, not value.
- A wide value is bounded by the LENGTH budget, not a breadth bound. Both fold accumulator fields must
  be forced each step, or a 31,000-element list inside both bounds aborts uncatchably.
- The depth bound's margin is about 6x, not 10x; the real guard is Nix `max-call-depth` (10,000),
  roughly 3 frames per level.
- A cycle is caught by the DEPTH bound alone; no length budget can save it.
- The purity scan must strip comments: the word "merges" in prose is a `merge` substring hit.
