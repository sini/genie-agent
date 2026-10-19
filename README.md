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
- `prompts/`: the model prompts. `tier1.md` with `skills/` (pi skills) is tier 1's;
  `tests/tier1-eval.ts` scores it live against `schemas/draft.json`.
- `ci/`: the gen-harness CI flake. Its workflow is `.github/workflows/ci.yml`.
- `docs/`: the design and the plan.
- `support-memory/`: the curated memory `genie-expert@public` reads, admitted only by a merged PR
  (see its README).

## genie-guard

`packages.<linux>.genie-guard` is guard-in as a service: a Node single executable, built like
`genie-dispatcher`, with `prompts/guard-in.md` bundled in. It registers on the owner's xmsg
(`$XDG_RUNTIME_DIR/xmsg`) as `genie-guard` and answers each message with one reply, then
acknowledges it. It reviews through the same `review` (`src/guard/service.ts`) as
`tests/guard-eval.ts`.

Published as an OCI image at `ghcr.io/sini/genie-guard` (`packages.<linux>.image`).

- It accepts message text that is one guard-in envelope, `{source, history, content}`, as
  `prompts/guard-in.md` describes it (`source` in `message`, `eval_stdout`, `recall`, `web`).
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

## Support Memory & Review Queue (Unit H2, Oracle 20)

Accepted thread resolutions are distilled into candidates and enqueued to a persistent review queue on disk (`<queueDir>/pending/<id>.json`).

The boundary is enforced across process and credential boundaries:

- The genie root process has only enqueue access to the queue directory and uses `HindsightRecallClient`, which lacks the `retain` method and holds no bank-write credentials.
- Approval is executed by the human owner running the standalone `genie-bank-review` CLI executable, configured with the write token.
- Deterministic checks (credential shapes, private memory markers) run at enqueue time and re-run at approve time.

Note: The boundary only holds if the live Hindsight API requires the write token (`Authorization: Bearer <token>`). If it accepts unauthenticated writes today, that is a deployment gap for the owner, not something to fix in code.

## Deployment (`nixosModules.default`)

`flake.nix` exports `nixosModules.default` (aliased as `nixosModules.genie-agent`), backed by the shared option surface in `nix/options.nix` (shared with the Kubernetes manifest renderer `I12`). It configures `genie-agent.service` (Tier 1 composition root on `pi`), optional `genie-guard.service`, and optional `genie-herdr@<tier>.service` + `genie-dispatcher@<tier>.service` (`public` and `trusted` expert tiers).

Each service is built as a standalone Node single executable (`sea { … }` in `flake.nix`), so `xmsg`'s `/proc/<pid>/exe` attestation (`programs.xmsg.server.svcExe`) pins each service's own store binary rather than shared `nodejs`:

- `svcExe.genie = lib.getExe genie-agent.packages.${system}.genie-root` (or `lib.getExe config.services.genie-agent.package`)
- `svcExe.genie-guard = lib.getExe genie-agent.packages.${system}.genie-guard` (or `lib.getExe config.services.genie-agent.guard.package`)
- `svcExe.genie-expert-public = lib.getExe genie-agent.packages.${system}.genie-dispatcher` (and `svcExe.genie-expert-trusted = lib.getExe genie-agent.packages.${system}.genie-dispatcher`)

> **Security & Isolation Trade-off (`nixosModules.default` vs. Kubernetes):** The NixOS system-service module runs Tier 1, the expert dispatchers, and expert Claude Code sessions on a single host under `services.genie-agent.user`, sharing that OS user's `xmsg` bus and Claude credentials. While systemd unit hardening (`ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`), Tier-1 path confinement (`C1`), and `bwrap --pure-eval` (`E1`/`E9`) bound accidental host writes and untrusted Nix evaluations, **single-user local mode does not provide kernel, network, or credential isolation between `@public` and `@trusted` expert sessions.** Operators serving untrusted public rooms with strict cross-tier isolation requirements must deploy the Kubernetes pod mode (`gVisor` `runsc` pods, Cilium network policies, and isolated per-tier credentials).

### Optional Guard Switches (`guard.enable` and `broker.guardOut.enable`)

For private or internal deployments where a guard model is unavailable or deemed unnecessary overhead, inbound and outbound model screening can be disabled independently (both default to `true`):

- **`guard.enable = false`** (`services.genie-agent.guard.enable = false`, with `guardRef = null` allowed): Disables `genie-guard` inbound model screening across all four input-screening points — inbound Matrix requests (`guardIn`), web results (`webScreen`; `G10` 32 KiB paging and per-thread caching still apply), recalled Hindsight entries and replayed archive transcripts (`seedGuard`), and escalation packages (`escalationGuard`). No `XmsgGuardClient` is constructed and no `xmsg` guard target is required. Tier 1 receives `UNSCREENED_PROMPT` via `--append-system-prompt` and `prompts/tier1.md` frames all inputs and tool outputs as untrusted data, but **gives up separate model-level prompt-injection filtering (`allow`/`rewrite`/`reject`) before untrusted text enters Tier 1 or an expert escalation package**.
- **`broker.guardOut.enable = false`** (`services.genie-agent.broker.guardOut.enable = false`): Skips the outbound `guard-out` model review on Tier 1 draft replies, deadline notices, expert replies, and broker proposals (`gist`/`pr`). **The deterministic credential redactor (`src/redactor/index.ts`) always runs unconditionally before any outbound post or broker action**, so shaped credentials and hashed secret lines are still scrubbed to `[redacted:<kind>]`, but turning `broker.guardOut.enable` off **gives up semantic model-level review for unshaped private context leaks or off-policy outbound text**.

## Tests

```sh
nix develop ./ci --command ci
nix develop ./ci --command ci --tests-error
```

## License

MIT
