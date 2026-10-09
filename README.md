# genie-agent

The tiered support expert behind `@genie` in Matrix. A local model answers den/gen/Nix questions
first, can reproduce a problem by evaluating (never building) the asker's configuration in a
sandbox, and escalates to a frontier model when it is not confident. Separate guard sessions
review every inbound message and every outbound answer.

Design: [`xmsg/genie-agent-design.md`](https://github.com/sini/den-ag-design/blob/main/xmsg/genie-agent-design.md)
in den-ag-design. The deployment lives in nix-config; this repository owns the agent.

## Layout

- `schemas/`: the JSON Schema wire contracts (guard verdict, tier-1 draft, eval request and
  result, escalation package, action proposal, thread state), with valid and invalid fixtures
  under `schemas/fixtures/<schema>/`.
- `src/`: the TypeScript package (pi's extension language).
- `ci/`: the gen-harness CI flake.

## Tests

```sh
nix develop ./ci --command ci
nix develop ./ci --command ci --tests-error
```

## License

MIT
