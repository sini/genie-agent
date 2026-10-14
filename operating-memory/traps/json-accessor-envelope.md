---
name: json-accessor-envelope
description: When writing a jq/JSON accessor against a tool or API you have not used this session
type: trap
---

**Rule:** Print the top-level shape before trusting any accessor: `jq -r 'type, (keys? // "array")'`. The envelope differs per subcommand and per endpoint.

**Why / measured:** three instances in one session, plus one from an API.

- A tracker CLI: `list` returns `{issues:[...]}`, `ready` a bare array, `show` an array. `.[]` on `list` read wrong at exit 0 (details in \[[br-native-text-for-models]\]).
- `nix flake metadata`: an overridden input lands as `<name>_2` via `root.inputs`, so `.locks.nodes["<name>"]` returned the pre-override node and reported "unchanged".
- `nix derivation show`: `{"derivations":{...},"version":N}`. `.[]` indexed the version number.
- A memory-service config API wraps settings as `{bank_id, config, overrides}`. A flat `.setting_name` returned `null` at exit 0 on a 25 KB response, which reads exactly like an unconfigured service.

The derivation-show miss failed loudly. The lock-node miss failed plausibly: it looked like a control that did not fire, which would have invalidated the subject reading without announcing itself. Budget your suspicion for the plausible failures.

**How to apply:**

- Probe `type`/`keys` first. A large byte count with a null answer is the tell.
- For anything override-aware, confirm you are on the post-override node (`nodes.${nodes.root.inputs.X}`).
- Use JSON only inside scripts. Give models the tool's native text, and never run a structured-data predicate over a human-formatted rendering, which wraps and splits tokens.

Related: \[[flake-lock-node-name-is-not-identity]\] \[[br-native-text-for-models]\] \[[tracker-br-traps]\]
