---
name: gen-identity-coordinates
description: When adding a coordinate (origin, namespace, class) to content-addressed identity in gen
type: practice
---

**Rule:** Add an identity coordinate so that its empty value is partition-preserving by construction. Hash with the minting function directly, and test the partition (same input gives the same id, distinct inputs give distinct ids), never string equality.

**Why / measured:**

- gen-link (cross-flake aspect federation) treats origin as just another identity key: `hashIdentity "aspect" (["origin"] ++ pathKeys ++ holeKeys)`. `origin = []` preserves the existing partition, so adding federation cannot disturb existing ids.
- Identity used `hashIdentity` directly, not reflection over the identity module, because reflection folds in `description` and would break the partition.
- `.key` stays the human name and `id_hash` is the content address, mirroring gen-schema's name/id split.
- gen-link is a pure conductor. It owns sequencing plus three coordinates (origin, disjoint-union with relabel, resolution manifest) and delegates hashing, resolution, graph and materialization. The manifest is a pure value; serializing a lock is the consumer's choice.
- A consumer reached the origin coordinate through gen-aspects' `aspectId` (the same formula gen-link delegates to), not through gen-link itself. Earlier notes said both "unstarted" and "done". Measure, do not trust either.
- Identity reflection that recognised only gen-types names silently dropped fields declared with nixpkgs `types.str`, collapsing two entities into one hash.
- Maps over terminals were keyed by identity hash plus class, not by coordinates, because function-valued declarations break JSON serialization.
- Identity for crossings of unmodified user modules follows nixpkgs' key rule: a file module is keyed by its path, an inline module by `<aspect identity>/<class>:anon-<index>`, and an explicit key wins.
- Keep the vocabulary sharp: keySemantics `channel` is not gen-pipe's Kahn-style channel. Fence homonyms in docs.

Related: \[[module-system-reimplementation-divergences]\] \[[gen-primitive-contracts]\] \[[oracle-design]\]
