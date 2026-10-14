---
name: graph-native-modelling
description: When designing data channels or queries in a graph-based configuration framework, or presenting design alternatives for one
type: practice
---

**Rule:** Put the graph-native arm on the table: things as nodes, relations as labelled edges,
consumers as (materialised) queries. Name every graph query as DIRECT (one edge) or REACHABLE
(transitive closure). There is no bounded "depth 2".

**Why:**

- A spec defaulted to a bespoke record channel, and the orchestrator recommended it. The owner
  asked whether there were better alternatives, then picked the instances-as-nodes arm because
  it "aligns more closely with the original design criteria of 'it's all a graph'", keeping
  the record as a staged subset. Local convenience channels had quietly replaced the design's
  own "instance nodes" line.
- Owner: a relationship has three cardinalities, 0 (unrelated), 1 (adjacent) and ∞
  (reachable). A bounded depth k > 1 is an arbitrary cutoff the graph model does not contain.
  A "DEPTH-1 / DEPTH-2" framing in the docs had conflated graph depth with WHERE a closure is
  computed.

**How to apply:**

- In every fork, include the node-plus-edge arm, check the governing design records for it,
  and say whether the convenient arm can be its staged subset. Scout buildability before
  ruling; do not drop the arm because a spec defaulted otherwise.
- Keep identity separate from edges. For example, an instance's identity is
  (aspect, context arguments); the node that reaches it is an EDGE.
- If a design introduces `depth`, `maxDepth` or a "level-2" concept, stop: it is either
  DIRECT or a full CLOSURE. Name a closure's locus by what it is ("computed here" or "routed
  through the library"), not as a depth.

Related: \[[design-bar-theory-not-compat]\] \[[before-asking-the-owner]\]
