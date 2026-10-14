---
name: codemod-verification
description: When building source-rewriting tools (codemods, migrators) driven by evaluator positions
type: practice
---

**Rule:** A non-null source position is not necessarily the right position. Check that the byte at the reported position is the token you expect, and verify a rename recipe by re-evaluating to an identical resolved model.

**Why:** A migrator for a config framework read positions with `unsafeGetAttrPos` from the pre-merge raw definitions, since submodule merging kills positions. A literal-attrset key gave the exact token position. An attrpath key (`x._.y = ...`) gave a non-null position pointing at the statement start, not at the token. That is the whole trap.

The design that came out of it, in three tiers:

1. Eval plus position lookup: exact, roughly 80% of cases.
2. Eval-known statement plus a parser that localizes the token: covers attrpaths and cross-file merges.
3. Parse and report: for computed keys, where there is no token to localize.

For a pure rename between two aliases of the same structural key, the resolved model must be identical before and after. Re-evaluation proves that the rename is behaviour-safe, which is stronger than re-type-checking. Prefer a lossless syntax tree (rowan/rnix style) for the rewrite itself.

A later finding narrowed the technique: merged option leaves in one reimplementation preserved declaration positions directly, so a different consumer needed no pre-merge threading. Re-check whether an expensive technique is still needed before citing it.

Related: \[[oracle-design]\] \[[one-engine-two-frontends]\]
