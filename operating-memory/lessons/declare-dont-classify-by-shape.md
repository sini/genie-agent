---
name: declare-dont-classify-by-shape
description: When code must decide what kind of thing a value is (class content vs namespace, reserved key vs nested entry)
type: practice
---

**Rule:** Decide categories by declaration (a schema, a registered option, an explicit marker), never by inspecting a value's shape.

**Why / measured:**

- A proposed predicate to tell a namespace apart from class content was rejected as empirically unsound. 36 real class bodies were structurally identical to a namespace (attrs, then attrs, then a registered key), so any predicate that catches one catches the other and drops real content.
- Value-shape classifiers were retired once every key's category (class / channel / facet) was declared in the schema and dispatch keyed on that declaration.
- Reserving a key like `settings` with a string exclusion list needs a second edit in a second place for every new key, and forgetting it mis-routes silently. Declaring it as an explicit option lets declared-beats-freeform do the reserving, and the key becomes typed.
- A classifier stayed correct only because it read declared options without triggering the freeform merge. Collapse that separation and the classifier forces what it is trying to classify.
- Dispatching parametric functions by arity misclassified a positional `ctx:` lambda (`functionArgs` is `{}`). Key on a wrapper marker instead.
- Keep a static interface (settings) at the top level, where introspection can reach it. Only the content that consumes it should be parametric. Wrapping a whole unit in a function hides the interface.

**How to apply:**

- When you reach for `looksLike...` or `isNested...`, add a declaration instead.
- Treat a trusted declaration (for example "this rule produces kinds X") as a contract. Validate it at definition time with a stamp step, and remember the stamp checks the declaration is consistent, not that the body obeys it.
- Feature-gate an inert surface rather than adding a predicate to work around it.

Related: \[[avoidance-off-ramp]\] \[[nix-hidden-unsoundness]\]
