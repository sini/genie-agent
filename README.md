# genie-agent

The tiered support expert behind `@genie` in Matrix. A local model answers den/gen/Nix questions
first, can reproduce a problem by evaluating (never building) the asker's configuration in a
sandbox, and escalates to a frontier model when it is not confident. Separate guard sessions
review every inbound message and every outbound answer.

Design: [`docs/design.md`](docs/design.md); the units it decomposes into: [`docs/plan.md`](docs/plan.md).
The deployment lives in nix-config; this repository owns the agent.

## Layout

- `schemas/`: the JSON Schema wire contracts (guard verdict, tier-1 draft, eval request and
  result, escalation package, action proposal, thread state), with valid and invalid fixtures
  under `schemas/fixtures/<schema>/`.
- `src/`: the TypeScript package (pi's extension language).
- `ci/`: the gen-harness CI flake. Its workflow is `.github/workflows/ci.yml`.
- `docs/`: the design and the plan.
- `support-memory/`: the curated memory `genie-expert@public` reads, admitted only by a merged PR
  (see its README).

## genie-guard

`packages.<linux>.genie-guard` is guard-in as a service: a Node single executable, built like
`genie-dispatcher`, with `prompts/guard-in.md` bundled in. It registers on the owner's xmsg
(`$XDG_RUNTIME_DIR/xmsg`) as `svc:genie-guard` and answers each message with one reply, then
acknowledges it. It reviews through the same `review` (`src/guard/service.ts`) as
`tests/guard-eval.ts`.

- It accepts message text that is one guard-in envelope, `{source, history, content}`, as
  `prompts/guard-in.md` describes it.
- A review replies `{"verdict", "reason", "cleaned_text"}`, parsed by `src/guard/verdict.ts`. A
  malformed model reply is a verdict: `reject`, with a reason that starts
  `guard-in output invalid: `. The model's own text is never relayed.
- No review replies `{"error": "…"}`. That covers text that is not an envelope (never sent to the
  model), and ninfer being unreachable, timing out, answering with an HTTP error or answering with
  no content. An error is not a verdict, so the caller holds the line and retries.
- At start it waits for ninfer's model (retrying `/v1/models`, 2 s backoff doubling to 60 s) and
  registers only once it answers; a 401 or 403 exits 2 with `unauthorized (check --api-key-file)`.

Settings, each a flag or the environment variable beside it: `--ninfer-url` /
`GENIE_GUARD_NINFER_URL` (required; ninfer's OpenAI base, ending in `/v1`), `--model` /
`GENIE_GUARD_MODEL` (default: the first model listed at `/v1/models` when the service starts), and
`--timeout-ms` / `GENIE_GUARD_TIMEOUT_MS` (default 120000, for each review), and
`--api-key-file` / `GENIE_GUARD_API_KEY_FILE` (optional; a path to a file holding the key, read
once at start and trimmed, sent as `Authorization: Bearer <key>` on `/v1/models` and
`/v1/chat/completions`; the key is never in argv, the environment or a log, and a file that is
unreadable or empty exits 2; unset sends no header). `tests/guard-eval.ts` takes the same
`--api-key-file`. `XDG_RUNTIME_DIR` is required. A bad setting exits 2 and names it.

## Tests

```sh
nix develop ./ci --command ci
nix develop ./ci --command ci --tests-error
```

## License

MIT
