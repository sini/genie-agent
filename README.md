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

Scoped message review is optional. The wire envelope accepts
`review_scope: "all" | "untrusted_lines"`, defaulting to `all`. Configure the exact producer
with `--scope-producer matrix-xmsg@example.node`, `GENIE_GUARD_SCOPE_PRODUCER`, or
`services.genie-agent.guard.scopeProducer` (default `null`). Only a matching structured xmsg
service/node origin without an instance ID can enable `untrusted_lines`, and only for message
sources. Missing, malformed or mismatched origins, unset configuration, and nonmessage sources
receive full review. Origin comes from the transport, never a payload or display name.

Scoped review classifies every public entry across history and content; trusted entries are
quoted context outside classification, never guard instructions or grants of permission.
Zero public targets in an authorized scoped envelope require no model call. Legacy `all`
still reviews trusted entries. Injection means one of the five prompt rules; task scope or
permission alone is not injection. The PR broker's public-only, fork-only and no-write-token
refusals (`src/broker/pr.ts`) and the eval sandbox enforce downstream authorization.

Use an XS2-capable xmsg daemon. Origin node fields are routing claims rather than general
cryptographic node authentication: replies return to their routed origin, and the Matrix
consumer accepts only its own pending request IDs. The guarantee concerns public entries;
a public reply quote inside a trusted entry remains trusted context, without separate review.
Deploy and verify the compatible guard and producer principal first, then enable the Matrix
producer's scope flag (default off). Disable that flag before rolling the guard back. An
incompatible request is an ordinary schema error; existing open failure mode can forward it
unscreened with a warning, so producer-first emission is unsupported.

The separate `corpus/injection-scope` synthetic fixtures exercise the contract without changing
the four existing corpora. The live evaluation harness accepts explicit `--model` and
`--timeout-ms`; scoped fixtures pass origin separately through production validation,
normalization and framing. `python3 tests/guard-scope-mutants.py <artifact-directory>` runs
source mutations against named structural assertions without model inference.

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

## Tier-1 credential custody

Root owns model and broker credentials. Each thread gets its own Unix socket; the socket binds Host
operations to that thread, and root chooses the configured model API, destination and authentication.
Pi receives public model metadata and a fixed nonsecret SDK presence placeholder, never the model key
in argv, environment or models.json. Put credential files outside every exported root, including state, worktrees, memory, application
source and runtime paths. Startup checks the same read-only bind list that constructs the jail. The evaluation harness uses the same root-mediated model path.

Packaged root pins the model SDK shipped with its pi dependency. Source runs resolve the SDK from
the configured pi executable (or an explicit `GENIE_PI_AI` module path). Selecting another pi process
in a packaged root config does not replace its pinned generation SDK. Root forwards normalized streaming
and tool events; disconnect or cancellation aborts upstream work. Pi cannot choose headers, credentials
or a different destination. Usable Linux bwrap adds the host jail; otherwise the portable baseline
logs `baseline: credential custody, no OS isolation` and runs without handing credentials to pi.

Custody is not OS secrecy: on a same-UID, unjailed baseline, this program can prevent its own credential
delivery and enforce its tool/read policy. It cannot claim that arbitrary compromised native code is
unable to inspect all files/processes owned by that UID. A separate OS user is the portable step up,
including on macOS.

## Portable root launcher

`packages.<system>.genie-root-node` (also the default package) provides `genie-root-node` on Linux
and macOS. It runs compiled JavaScript with the packaged schemas, prompts, skills and pi extension,
and pins the same shipped model SDK used by the Linux SEA:

```sh
nix build .#genie-root-node
./result/bin/genie-root-node --config ./genie.json
```

The wrapper supplies pi, Nix, Git and coreutils on PATH, plus immutable CA bundle defaults for TLS. It preserves the ambient PATH for optional
host adapters. The Linux `genie-root` SEA remains available for executable attestation; the portable
Node wrapper does not provide the SEA's executable identity guarantee. A missing jail or cgroup is
reported as a baseline or an unenforced memory request, rather than a platform refusal. Evaluation
keeps pure-eval and a clean environment; no restrict-eval policy is enabled by default. A cgroup
budget covers the evaluator and its owned children, not daemon or remote builders.

Run `nix run .#portable-baseline` to exercise the compiled Root/Pi launch and native Nix with
local fixtures. CI runs this process check outside the Nix build sandbox; the
`portable-baseline` flake check separately validates the compiled Root/Pi launch.

For a separate Pi container sharing only its thread socket, or evaluation as Kubernetes Jobs,
see [configured executors](docs/executors.md). Both adapters require explicit deployment inputs;
configured failures never select the local fallback.

## Tier-1 OCI image

`packages.<linux>.root-image` builds `ghcr.io/sini/genie-root`. The existing
`packages.<linux>.image` output remains the guard image. Both support the flake's
Linux architectures.

```sh
nix build .#root-image --out-link result-root-image
nix build .#checks.x86_64-linux.root-image .#checks.x86_64-linux.root-image-fixtures
docker load < result-root-image
```

The root image runs as `65532:65532` and enters the `genie-root` Node single
executable. It includes the portable runtime tools: `pi`, `nix`, `git` and coreutils.
It does not ship bwrap; that remains an optional host adapter. `PATH`, `SSL_CERT_FILE`, `NIX_SSL_CERT_FILE`
and `GENIE_REPO_ROOT` point to the packaged runtime, CA bundle and root source.
Python runs only in the offline archive checks; this change adds no Python
runtime dependency.

The exact `packages.<linux>.operating-memory` corpus is copied to `/memory`.
Its files are root-owned `0444`, directories are root-owned `0555`, and the image
declares no volume there. The archive oracle compares a canonical manifest of
relative paths and file SHA-256 hashes, checks ownership and modes, and resolves
the actual runtime/source/CA paths across layers. A declared memory volume or a
changed corpus fails the check. Deployment manifests must separately avoid any
writable mount over `/memory`; image metadata cannot enforce a pod's mounts.

Supply the normal root configuration through `--config <path>` or `GENIE_CONFIG`,
set `tier1.memoryRoot` to `/memory`, and provide the configured state/runtime paths
and xmsg connection. The image contains no credentials and does not configure a
bus or a deployment. It also includes `/bin/genie-container-worker` for the separate
Pi container, selected by overriding the entrypoint. Its contents do not prove
deployment mount, network or runtime isolation; verify those in the intended sandbox.

The OCI workflow builds and checks both images for pull requests. Only a push to
`main` publishes `latest` and `sha-<short-commit>` tags for each image. A branch
build does not publish an image.

## Deployment (`nixosModules.default`)

`flake.nix` exports `nixosModules.default` (aliased as `nixosModules.genie-agent`), backed by the shared option surface in `nix/options.nix` (shared with the Kubernetes manifest renderer `I12`). It configures `genie-agent.service` (Tier 1 composition root on `pi`), optional `genie-guard.service`, and optional `genie-herdr@<tier>.service` + `genie-dispatcher@<tier>.service` (`public` and `trusted` expert tiers).

Each service is built as a standalone Node single executable (`sea { … }` in `flake.nix`), so `xmsg`'s `/proc/<pid>/exe` attestation (`programs.xmsg.server.svcExe`) pins each service's own store binary rather than shared `nodejs`:

- `svcExe.genie = lib.getExe genie-agent.packages.${system}.genie-root` (or `lib.getExe config.services.genie-agent.package`)
- `svcExe.genie-guard = lib.getExe genie-agent.packages.${system}.genie-guard` (or `lib.getExe config.services.genie-agent.guard.package`)
- `svcExe.genie-expert-public = lib.getExe genie-agent.packages.${system}.genie-dispatcher` (and `svcExe.genie-expert-trusted = lib.getExe genie-agent.packages.${system}.genie-dispatcher`)

> **Security & Isolation Trade-off (`nixosModules.default` vs. Kubernetes):** The NixOS system-service module runs Tier 1, the expert dispatchers, and expert Claude Code sessions on a single host under `services.genie-agent.user`, sharing that OS user's `xmsg` bus. The expert tiers do not share that user's Claude credentials: each tier authenticates with its own Claude setup-token, which systemd reads from `experts.<tier>.tokenEnvironmentFile` into that tier's `genie-herdr@<tier>` unit only, and no expert unit mounts the user's `~/.claude` beyond the tier's configured memory directory, read-only. While systemd unit hardening (`ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`, and `PrivatePIDs=true` on the expert units), Tier-1 path confinement (`C1`), and `bwrap --pure-eval` (`E1`/`E9`) bound accidental host writes and untrusted Nix evaluations, **single-user local mode does not provide kernel or network isolation between `@public` and `@trusted` expert sessions, which run as the same OS user.** Operators serving untrusted public rooms with strict cross-tier isolation requirements must deploy the Kubernetes pod mode (`gVisor` `runsc` pods, Cilium network policies, and isolated per-tier credentials).

### Gist proposals

The existing `propose` tool accepts `gist_read`, `gist_update` and `gist_comment`
alongside gist creation and PRs. Reads return bounded, screened, explicitly
untrusted data. With `broker.tokenFile = null`, anonymous gist reads remain
available and credentialed writes remain disabled. Gist creation defaults to
secret/unlisted; public creation requires an explicit flag. See
[broker operations](docs/broker.md) for proposal shapes, account ownership checks,
limits, guard behavior and local fake-API tests.

### Optional Guard Switches (`guard.enable` and `broker.guardOut.enable`)

For private or internal deployments where a guard model is unavailable or deemed unnecessary overhead, inbound and outbound model screening can be disabled independently (both default to `true`):

- **`guard.enable = false`** (`services.genie-agent.guard.enable = false`, with `guardRef = null` allowed): Disables `genie-guard` inbound model screening across all four input-screening points — inbound Matrix requests (`guardIn`), web results (`webScreen`; `G10` 32 KiB paging and per-thread caching still apply), recalled Hindsight entries and replayed archive transcripts (`seedGuard`), and escalation packages (`escalationGuard`). No `XmsgGuardClient` is constructed and no `xmsg` guard target is required. Tier 1 receives `UNSCREENED_PROMPT` via `--append-system-prompt` and `prompts/tier1.md` frames all inputs and tool outputs as untrusted data, but **gives up separate model-level prompt-injection filtering (`allow`/`rewrite`/`reject`) before untrusted text enters Tier 1 or an expert escalation package**.
- **`broker.guardOut.enable = false`** (`services.genie-agent.broker.guardOut.enable = false`): Skips the outbound `guard-out` model review on Tier 1 draft replies, deadline notices, expert replies, and broker write proposals (gist create/update/comment and PRs). Read requests do not invoke guard-out; fetched gist data uses the global inbound guard setting. **The deterministic credential redactor (`src/redactor/index.ts`) always runs unconditionally before any outbound post or broker action**, so shaped credentials and hashed secret lines are still scrubbed to `[redacted:<kind>]`, but turning `broker.guardOut.enable` off **gives up semantic model-level review for unshaped private context leaks or off-policy outbound text**.

## Tests

```sh
nix develop ./ci --command ci
nix develop ./ci --command ci --tests-error
```

## License

MIT
