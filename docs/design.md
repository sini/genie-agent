# Design: `genie-agent`, the tiered support expert behind `@genie`

_Owner brainstorm, 2026-10-08 (session `den-ag-design-44`). Every section below was approved in
that session. Where a choice is marked *defaulted, reversible*, the owner did not rule on it
explicitly._

_Revision 2, 2026-10-08: folds the design gate (`reports/genie-agent-design-gate.md` (private design repo), REJECT,
F1–F10). No §2 ruling is re-opened; §12 maps each finding to where it is resolved._

_Revision 3, 2026-10-08: folds the second gate contact (`reports/genie-agent-design-gate-rev2.md` (private design repo),
ACCEPT-WITH-CHANGES, R1–R7), mapped in §12 as well._

_Revision 4, 2026-10-08: adds the expert-tier dispatcher (§5.8) on two owner rulings, rows 14 and
15, and folds the D0 herdr spike (`reports/genie-d0-herdr-spike.md` (private design repo)), which measured it._

_Revision 5, 2026-10-08: folds the dispatcher gate (`reports/genie-dispatcher-design-gate.md` (private design repo),
REJECT, F1–F10, P1–P3) on four owner rulings, rows 16–19; §12 maps each finding._

## 1. Purpose

`@genie` answers den/gen/Nix support questions in Matrix rooms, including public ones. It is a
tiered expert. A local model fields every question first, and it escalates to a frontier model
when it cannot answer confidently or when the asker asks it to. It can reproduce a user's problem
by **evaluating** (never building) the user's GitHub configuration inside a sandbox, and no
user-supplied configuration can exhaust a host.

This design amends `genie-k8s-federation-plan.md` (private design repo). The bot and its first-tier expert move into
Kubernetes, and the frontier tier stays on a workstation as the users `genie-public` and
`genie-trusted`.

## 2. Rulings

| #   | question                                                                | ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What "evaluate a config" means                                          | **Eval only.** `nix eval` / `flake check --no-build`. We don't compile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | Tier-1 model                                                            | Qwen 3.8 27B on ninfer (`cortex-cuda`). The design uses the measured **145,408-token shared pool** (`nix-config modules/den/hosts/cortex-cuda.nix`, `maxContext`). The model, window and concurrency are **configuration**: a migration to Qwen 3.8 35B-A3B MoE (~1.5M context, or ~5 parallel agents) changes only numbers.                                                                                                                                                                                                                                                                                          |
| 3   | Where tier 1 runs                                                       | **A k8s pod** (axon, ns `matrix`) beside matrix-xmsg and the xmsg leaf. cortex and bitstream are reserved for the Opus tier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | Frontier tier's access                                                  | **A dedicated `genie` user, plus an approval channel.** It has read-only access to sini's `~/.claude` memories and the checkouts. Any action needing credentials becomes a proposal to sini.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | Frontier tier's credential                                              | genie's **own** `claude setup-token` token (revocable on its own), not sini's credential file, which the tools cannot read. The owner added an LLM review layer (row 6) on top of this. *Defaulted, reversible.* Amended by row 15: the credential is a per-tier pool of subscription tokens.                                                                                                                                                                                                                                                                                                                         |
| 6   | Injection defence                                                       | **A separate guard agent** reviews and reformats every inbound message and reviews every outbound answer. It runs on the **local Qwen** (the owner rates it at ~Opus 4.5–4.6), in separate sessions, in both directions.                                                                                                                                                                                                                                                                                                                                                                                              |
| 7   | When to escalate                                                        | **Hard triggers force it; otherwise self-assessed confidence decides.** The self-assessment is **shown with the answer**, and the asker can **accept** or **request a deeper evaluation**.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8   | Session lifetime                                                        | **Per thread**, destroyed after acceptance or 24h idle. Accepted Q&A is distilled into a **dedicated genie hindsight bank**, with review before admission.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 9   | Eval sandbox                                                            | **One k8s Job per eval under gVisor** (`runtimeClassName: gvisor`), limits **12Gi / 2 cores**. **IFD** is off by default and allowed as a **trusted override**.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | Trusted IFD builds                                                      | Go to **remote builders**, including **uplink** (24 threads, 128GB), as a dedicated build user. *Hardening defaulted, reversible* (§5.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 11  | Repo boundary                                                           | **genie-agent owns the agent, nix-config owns the deployment** (the matrix-xmsg pattern). The future target, once den runs on gen and gen-link exists, is for the repo to ship its own k8s shape.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 12  | Who builds                                                              | **Claude (Opus) gen-build agents.** Prompts and skills are critically reviewed against `writing-for-agents` and the existing quality skills. agy stays on xmsg and matrix-xmsg.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | Expert memory by tier (gate F2)                                         | **Trusted senders:** the expert reads sini's private memory; the risk is accepted, and trusting the user is the operational cost. **Public senders:** the expert reads only a curated, pre-redacted support memory, maintained separately, which also keeps the agent focused on the classes of task at hand. The authenticated sender tier selects the view, never a model, and the two views are never co-mounted. The gate's two fixes apply in both cases: the escalation package is guarded before Opus ingests it, and the redactor is a backstop. Realised in §5.1, §5.2 layer 5 and §4 step 6.                |
| 14  | Expert lifecycle (owner, 2026-10-08)                                    | **Option (c), on herdr, with no `claude -p`.** Each escalated thread is its own **interactive** Claude Code session in a pane of a per-tier herdr session, run as `genie-<tier>`. A small resident **dispatcher** per tier maps `thread_id` → Claude session id. Messages travel over xmsg; herdr does only the lifecycle: start, park (close the pane on idle) and resume (`--resume` in a new pane). **The tier only ever drops:** a thread that falls from trusted to public is never resumed in `@trusted`; it starts fresh in `@public`, seeded only with the guarded package. Realised in §5.8.                 |
| 15  | Expert tokens (owner, 2026-10-08)                                       | **Subscription tokens only, never API keys.** When a token's quota runs out, that tier stops answering ("expert unavailable"), with **no fallback**. Each tier has a **token pool**: each contributor's subscription token is its own agenix secret; adding the file shares it, and `git rm` stops it. A thread is **pinned** to the token it started on (`--resume` needs that account's transcripts). Contributor tokens feed the **public** tier only; the owner's token serves `@trusted`. Contributors are told their quota answers public questions. Realised in §5.8.                                          |
| 16  | The owner's token in `@public` (owner, 2026-10-08; was open question 4) | **Yes, under a daily cap.** The owner's token also serves `@public`, up to a daily cap on public escalations (a small default, a typed setting). Past the cap, `@public` answers "expert unavailable" until the daily reset. Contributor tokens are preferred when present. The dispatcher counts per token per day (D4b).                                                                                                                                                                                                                                                                                            |
| 17  | Config directory (owner, 2026-10-08; was open question 5)               | **One `CLAUDE_CONFIG_DIR` per token.** The pin holds by storage, and a contributor's account never holds another contributor's transcripts. xmsg discovers Claude sessions from several session directories (X7). The directory carries `.claude.json`, so workspace trust and onboarding are per directory too.                                                                                                                                                                                                                                                                                                      |
| 18  | The xmsg bus on a shared host (owner, 2026-10-08; gate F1)              | **xmsg's HTTP API moves off loopback TCP onto a per-user unix socket** (0600, a peer-cred uid check: the `agent.sock`/`register.sock` pattern). Each OS user (`genie-public`, `genie-trusted`, `sini`) runs its own xmsg instance, so a process reaches only its own user's bus, and **the tier fence holds by construction**, with no network namespace and no nftables rule. Tier expert sessions get a **reply-only** xmsg MCP mode (no `list`, no `send`). Only pinned, allow-listed federation links cross tiers or hosts. The k8s pod's in-pod loopback stays: it is a private network namespace. xmsg unit X8. |
| 19  | The dispatcher's xmsg identity (owner, 2026-10-08; was open question 3) | **Arm (a): a `svc:` daemon harness kind.** The dispatcher registers on its own user's `register.sock`, attested by a trusted executable and the peer uid, as agy is. xmsg unit X9.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 3. Components and flow

```
Matrix ─► matrix-xmsg ─► guard-in ─► tier-1 (per thread) ──────────────────────────► guard-out ─► redactor ─► matrix-xmsg ─► Matrix
          (tier tag)                   │  eval-launcher (clamps trust) → Job (gVisor)        ▲              (backstop)
                                       │  skills, docs, recall ◄─ guard-in                    │
                                       └─ escalate (🔍 / forced) ─► guard-in ─► xmsg ─► genie-expert@<tier> ─┘
```

Every answer passes through guard-out and the redactor, tier 1's as well as Opus's. Everything
that re-enters a model context from storage or from an eval passes guard-in first.

- **genie-agent pod** (k8s, ns `matrix`): the containers `matrix-xmsg`, `xmsg` (leaf mode, X2) and
  `genie-agent`. In the last, the **supervisor** runs three kinds of pi process against ninfer:
  `guard-in`, a tier-1 session per thread, and `guard-out`. Each is a separate process with a
  separate context. The supervisor holds each thread's **sender tier** (§5.1), which no model can
  write.
- **eval-launcher**: the only component with Kubernetes RBAC, limited to creating, watching and
  deleting Jobs in ns `genie-eval`. It takes the thread's tier from the supervisor, not from the
  model's tool call.
- **Opus expert**: Claude Code on bitstream, as two instances, `genie-expert@trusted` and
  `genie-expert@public`, each its own OS user with its own memory view and repository set (§5.2
  layer 5). Each instance is a resident **dispatcher** that receives the escalation package over
  xmsg federation and runs one interactive Claude Code session per thread in its tier's herdr
  session (rows 14–19, §5.8).
- **distiller**: after an accept, it proposes a hindsight entry into the review queue.
- **support-memory curator**: maintains the pre-redacted support memory that
  `genie-expert@public` reads (row 13), `support-memory/` in `genie-agent`. Its changes are PRs,
  and a human merge admits them (§4 step 7).

## 4. Lifecycle of a request

1. **Intake.** matrix-xmsg receives a message, admits it under its admission option (public
   senders are admitted only where the option is on; otherwise they are dropped silently, as
   today), and passes it with thread context. Every line, the trigger message's and each history
   line's, carries its sender's authenticated tier, `trusted|public`, which matrix-xmsg computes
   from the Matrix sender id, never from message text. **The supervisor reads the tiers from this
   raw envelope, before guard-in**, and sets the thread's tier (§5.1); it never reads a tier from
   guard-in's `cleaned_text`. guard-in then reviews the message **and the thread history it
   carries**, and
   returns `{verdict: allow|rewrite|reject, reason, cleaned_text}`. On reject, the bot posts a
   short refusal and tier 1 never sees the text.
2. **Session.** The supervisor finds or creates the thread's tier-1 session. It seeds the session with skills, a recall from the genie hindsight bank and the
   cleaned question. The recall passes guard-in before it seeds, because bank content is
   attacker-derived text re-entering a fresh context.
3. **Work.** Tier 1 may call `eval {repo, rev, attr, trusted}` and receives
   `{exit, stdout_tail, stderr_tail, limit_hit: none|oom|timeout|egress}`. The `trusted` argument
   is a **request**: the launcher runs a trusted Job only when the request is set **and** the
   thread's tier is trusted, so the model can lower trust but never raise it. Evals run one at a
   time per thread; a second request waits for the first Job to end.
4. **Draft.** The output is `{answer, confidence: 0..1, gaps: [], escalate_forced: bool}`. The
   hard triggers that set `escalate_forced`:
   - an eval reproduced an error that tier 1 cannot explain;
   - the answer needs code absent from the read-only checkouts;
   - the question touches gen/den internals beyond its skills;
   - the user asked for the expert.
     Otherwise a confidence below the threshold (initially conservative) escalates.
5. **Reply.** guard-out runs, then the redactor, then the bot posts the answer with a confidence
   line, its gaps and the controls. The controls are *defaulted, reversible*: reaction ✅
   accept, 🔍 deeper, and a text fallback `!deeper`. Only the asker or a trusted MXID may trigger
   🔍.
6. **Escalation.** The package `{cleaned_question, draft, eval_transcript, gaps}` passes guard-in,
   in a fresh session, before it leaves the pod: `draft` and `eval_transcript` carry
   attacker-influenced text (eval stdout). The supervisor then sends it over xmsg to the expert
   instance the thread's tier selects, `genie-expert@trusted` or `genie-expert@public`. Its answer
   returns through guard-out and the redactor and is posted in the thread, marked "expert review".
   An expert reply that guard-out blocks is **dropped** from tier 1's context and from the thread
   transcript, and archived with a tier label only. It never enters a later package, draft or
   replay.
7. **Close.** On ✅, or after 24h idle, the transcript is archived and the session destroyed. On ✅
   the distiller proposes a hindsight entry. Admission needs a **human approval**. Deterministic
   checks (credential shapes, known secret bytes, planted markers) run first and may only refuse;
   no check and no model admits. A model-reviewed bank would carry one poisoned Q&A into every
   future session, and no deterministic predicate recognises a prose leak or an injection.

**Failure modes:**

- ninfer down or saturated: the bot says it is busy and queues the question. It never falls back
  to Opus on its own.
- xmsg unreachable during an escalation: the asker is told the expert is unavailable.
- The thread's pinned token, or every token in its tier's pool for a new thread, is out of quota:
  the asker is told the expert is unavailable. Nothing falls back to another token or tier (row
  15).
- The dispatcher or the herdr server is down, or an expert turn passes its reply timeout: the
  asker is told the expert is unavailable. The dispatcher's journal survives its restart, and the
  panes survive a dispatcher restart (§5.8).
- An eval hits a limit: tier 1 reports which limit was hit, as a finding.

**Latency (accepted cost, *defaulted, reversible*).** ninfer's pool is shared (`maxConcurrency = 4`) and prefill is serialized. A request spends three sessions in series (guard-in, tier 1,
guard-out), plus guard-in passes over recalls and escalation packages, and a full-pool resume is
≈138s of prefill at ~1,050 tok/s. Under concurrent threads this is a latency ceiling, not a safety
issue; the queue in the first failure mode absorbs it.

## 5. Trust, isolation and limits

### 5.1 Trust levels

The tier comes from matrix-xmsg's authentication: kanidm admins and `extraTrustedMxids` are
trusted, and any other admitted sender is public. The supervisor reads each line's tier from
matrix-xmsg's envelope at intake, before guard-in (§4 step 1). A **thread's tier** is the lowest tier among the
senders whose text the thread carries: it falls to public when a public sender's text enters, and
never rises. The supervisor records it in the thread state. Every tier-dependent capability below
reads it from there, never from a model's output.

- **Public thread:** guard-in; eval with IFD off; escalation to `genie-expert@public`.
- **Trusted thread:** the trusted-IFD path; escalation to `genie-expert@trusted`.
- **Trusted MXID:** 🔍 on any thread. A trusted 🔍 on a public thread escalates to
  `genie-expert@public`: the controller's tier does not change the thread's.
- **Opus expert:** receives only the guarded package (§4 step 6), never raw Matrix text.

### 5.2 Layers

The guarantees are constructions: a credential never enters a model context (layer 3), and
private memory, private repositories and unpublished files never enter an Opus context that
answers a public thread (layer 5). The redactor
(layer 6) is a backstop over both, never the guarantee: it matches shapes and known bytes, not
prose.

1. **Model:** guard-in and guard-out are separate sessions that never share context with tier 1
   or with each other.
2. **Process:** each pi session gets a tool allowlist. Tier 1 has `eval`, `recall`, `escalate` and
   `reply`, and **no shell**.
3. **Pod:** each credential is held only by the container that needs it: the Matrix token in the
   bot container, the leaf key in the xmsg container, and the launcher's namespaced RBAC. Egress is
   allowlisted to ninfer, the federation peers' `:7788` and the Matrix homeserver.
4. **Eval:** each eval runs as its own gVisor Job, starting from nothing, with:
   - 12Gi memory and 2 cores, request = limit (Guaranteed QoS);
   - `activeDeadlineSeconds: 120`;
   - a size-limited `emptyDir` as scratch space (`TMPDIR` and the eval's temporary files), which
     is not a store;
   - `allow-import-from-derivation = false`, no builders and no substituters;
   - `--pure-eval`, an empty `NIX_PATH` and an empty flake registry, so `builtins.getEnv`,
     `<nixpkgs>` and reads outside the inputs fail;
   - one Nix store, the thread's store volume, mounted as the Job's store root, so fetched inputs
     persist across the thread's evals (§6). The local runner (E1) uses a throwaway store in its
     place;
   - mounts of the repo source under evaluation (read-only), the store and the scratch `emptyDir`
     only, plus the builder key on a trusted Job (§5.3). Nothing from the thread's state is
     mounted: no transcript, eval cache, verdicts or environment;
   - one Job in flight per thread, because the thread's store volume is RWO (Longhorn binds one
     node, and two `nix` writers on one store race);
   - egress limited to fetching inputs (github.com, codeload.github.com, the nixpkgs
     channel/tarball hosts). `genie-eval` is excluded from the cluster's `allow-internal-egress`
     CCNP, so the allowlist is the Job's only egress. The allowlist is host-coarse, so an eval can
     reach an attacker's GitHub URL. An untrusted Job holds nothing of the thread and no
     credential, so there is nothing to send; a trusted Job also holds the builder key, which pure
     eval cannot read (§5.3).
5. **Expert:** two instances on bitstream, each its own OS user: `genie-expert@public` runs as
   `genie-public` and `genie-expert@trusted` as `genie-trusted`, each with a 0700 home. The
   supervisor picks the instance from the thread's tier.
   - **Memory:** `@trusted` bind-mounts `~sini/.claude/memory` read-only; `@public` bind-mounts
     the support memory, `support-memory/` of the `genie-agent` clean clone below, read-only. No
     instance mounts both views;
   - **Repositories:** `@trusted` bind-mounts the owner's den/gen/xmsg checkouts read-only
     (ruling 4). `@public` mounts only **public** repositories, as clean clones at their published
     revision (the origin default branch), kept by a root-owned sync: never an owner working tree,
     which carries ignored and untracked files, and never a private repository. *Defaulted,
     reversible* (gate R2);
   - **Writable set:** an allowlist per instance, `ProtectSystem=strict`, `PrivateTmp=true` and
     `ReadWritePaths` = its own home only, so nothing one tier writes is readable by the other;
   - its tier's token pool (rows 15–17, §5.8), each token its own agenix secret, root-owned and
     read only by systemd (`LoadCredential`). Each pane gets only its own token, as
     `CLAUDE_CODE_OAUTH_TOKEN`. The tools are denied the whole credentials directory, every
     per-thread token directory, `/run/agenix.d/**`, `/proc/*/environ` and every config
     directory's `projects/`, through both Bash and Read (Claude Code's bubblewrap sandbox and its
     permission deny);
   - **Bus:** its own xmsg instance on a per-user unix socket, and a reply-only xmsg MCP in each
     session (row 18). No link joins the two tiers' nodes;
   - no ssh agent, gh, kube, agenix or S3 identity. The expert archive's key is held by the
     archiver alone (§6).
6. **Output:** guard-out runs, then a deterministic redactor (credential-shaped patterns plus a
   hash match against known secret files), and only then does anything post. The shapes it
   matches are those of the credentials in scope: the Matrix access token, every pool token
   (`CLAUDE_CODE_OAUTH_TOKEN`, by shape only: the pod does not hold the pool tokens, so it has no
   hash of them), the `genie-bot` fine-grained PAT (`github_pat_…`), the xmsg leaf
   ed25519 key material, and the Longhorn and Garage S3 keys.

### 5.3 Trusted IFD

The trusted path adds `allow-import-from-derivation = true`, `builders` pointing at the remote
builders, and `cache.nixos.org` plus the builders' ssh port to the Job's egress. The Job keeps
`max-jobs = 0`, so nothing builds in-pod: IFD derivations build on the remote builders, under Nix's
own sandbox. Only the launcher's clamp (§4 step 3) opens this path.

The builder ssh key and its `known_hosts` reach the Job as a Kubernetes Secret, mounted read-only
only into a Job whose effective trust is trusted. Only Nix's builder connection uses it; eval code
cannot read it, because pure eval refuses paths outside the eval's inputs.

### 5.4 Remote builders (uplink first)

uplink is the edge host (FRR, the public nginx). Its builder role is *defaulted, reversible*:

- a dedicated `nix-remote-build` user with Nix's sandbox enforced, reusing nix-config's
  `roles.nix-builder` (`remote-build-server.nix`: the restricted `nix-store --serve --write` key)
  rather than a hand-rolled builder;
- an ssh key admitted only from the `genie-eval` namespace's egress;
- a systemd slice capping CPU and memory, plus `max-jobs`, so builds cannot take capacity away
  from routing.

### 5.5 Network exposure

There is no static route to ninfer. The axons (prod) reach it through a prod→dev UniFi firewall
policy in nix-config's terranix config, admitting `axons → cortex-cuda:8081`. The ninfer guest
admits its consumers by their den address, or by their environment's CIDR when they have none. A
Cilium CNP admits only `genie-agent → ninfer:8081` within the cluster.

### 5.6 Actions: gists and PRs (ruled: a `genie-bot` account behind a broker)

- **Action broker.** The only holder of a fine-grained token for the GitHub machine account
  `genie-bot`, scoped to gists and to public forks and PRs. No model ever holds it. Models emit a
  typed proposal, `{kind: gist|pr, repo, branch, files, title, body}`. Every proposal passes
  guard-out and the redactor before the broker acts, and the broker records each action against
  its thread id.
- **The PR loop.** The agent describes the fix in the thread and offers to open a PR. The asker's
  yes opens it. **The PR is itself the check**: the user reviews it and can close it if they
  change their mind, so there is no separate preview gate. The PR body links the thread.
- **Gists** are posted after guard-out.

### 5.7 Secrets

The bot **never asks a user for a secret**. Eval rarely needs one. Where a secret does block an
eval, tier 1 works around it first, by stubbing the agenix/sops paths or substituting placeholder
values for the secret attributes in the eval. If no workaround exists, it says plainly that the
secret blocks the eval and what it would have checked.

### 5.8 The expert dispatcher (rows 14–19)

Each tier runs one resident **dispatcher** as `genie-<tier>`. It is the principal
`svc:genie-expert` on that tier's own xmsg instance (row 19), which is what the supervisor
addresses as the tier's expert. It holds the map `thread_id → {session uuid, token, live|parked}`
and the per-thread buffers, and it drives the tier's own herdr session. Messages travel only over
xmsg; herdr does only the lifecycle. The D0 spike measured the mechanism
(`reports/genie-d0-herdr-spike.md` (private design repo): herdr 0.9.3, Claude Code 2.1.292 and xmsg 0.1.0 on cortex, run
as `sini`), and each step names the spike question that measured it. What D0 did not measure,
because it ran as `sini`, is listed under Prerequisites and measured by I10.2.

**Topology (rows 18 and 19).** bitstream hosts three xmsg nodes, one per OS user:
`genie-public@bitstream`, `genie-trusted@bitstream` and `sini@bitstream`.

- Each instance serves its HTTP API only on `$XDG_RUNTIME_DIR/xmsg/http.sock` (mode 0600, a
  peer-cred check that the peer's uid is the server's), the `agent.sock`/`register.sock` pattern,
  and binds no TCP socket (X8). A process reaches only its own user's bus, so the tier fence
  holds by construction, with no network namespace and no nftables rule.
- Each tier instance discovers Claude sessions from every per-token config directory of its
  tier (`--sessions-dir` per directory, X7), and its dispatcher registers on its own
  `register.sock` as `svc:genie-expert`, attested by a trusted executable and the peer uid (X9;
  the `svc` harness of `xmsg-federation-design.md` (private design repo) §3.2, given an inbox).
- The thread sessions load the xmsg MCP in **reply-only** mode (`xmsg mcp --reply-only`, X8): no
  `list`, no `send`.
- Federation links (`xmsg-links`, federation plan §6.1) re-cut the one link to `genie@bitstream`
  into two: `genie(leaf) → genie-public@bitstream : send` and `genie(leaf) → genie-trusted@bitstream : send`, each with principal `svc:genie-expert` only. The dispatcher's
  reply returns on the federation reply route (`POST /fed/v1/replies`, target → origin), which
  this design does not change. No link joins the two tier nodes, or either of them to `sini@*`.
- The pod's in-pod loopback stays as it is: it is a private network namespace (federation plan
  §6.3).

**Units.** The herdr server runs in its own unit per tier, `genie-herdr@<tier>`, and the
dispatcher in another, `genie-dispatcher@<tier>`. A change to the token pool restarts only the
dispatcher's unit, because `LoadCredential=` is read once at start and cannot be reloaded in place.
The panes live in the herdr unit's cgroup and survive. Each live pane keeps the token it started
with until it parks.

**State (gate F2).** The map, the per-thread buffers, the token states and the outstanding
message ids are a journal under the tier's home. A message is journalled before the dispatcher
acknowledges it to xmsg, and X9's long-poll advances its cursor only on that acknowledgement. On
start, the dispatcher reconciles the journal against `herdr agent list` and xmsg's session list,
marks any thread whose pane is gone as parked, and re-arms the reply long-poll for every
outstanding message id.

**Server** (Q2). `setsid herdr --session <tier> server` runs headless, with no client and no TTY.
`herdr --session <tier> status` does not start a server. Every herdr command passes `--session <tier>` and runs with `HERDR_SOCKET_PATH` and the pane, tab and workspace variables unset;
otherwise it reaches whatever session the environment names.

**Launch** (Q1, Q3). The dispatcher picks the thread's token, mints a uuid and journals both. It
then runs `herdr --session <tier> pane split … --cwd <tier cwd>` and `herdr --session <tier> agent start <n> --kind claude --pane <pane> -- -n <name> --session-id <uuid> [--model …]` through the
token shim (below), under the token's own `CLAUDE_CONFIG_DIR` (row 17). The uuid is the xmsg
`sessionId`, the `--resume` key and the transcript name at once, so the dispatcher holds the
address before the process exists and never discovers it. xmsg listed the session about 3 s after
the start.

**Talk** (Q4, Q5; gate F4).

- The dispatcher forwards the guarded package to the thread's session over its own instance, and
  relays the session's reply as its own reply to the supervisor's message.
- **The end of a turn is the xmsg reply**, read by long-polling `/v1/messages/{id}/replies?wait=…`.
  herdr state (`working`, `idle`, `blocked`) is only the liveness watchdog. A bare `herdr agent wait` returns at once on an idle session, and the server needs about 1 s to see a turn start, so
  it can return before the turn begins.
- **Delivery is at most once.** Every send carries an idempotency key, the supervisor's message id
  plus a sequence number (X10). A send is retried only with the same key, so a POST whose response
  was lost does not deliver twice.
- **Readiness.** A session is ready when xmsg lists its uuid, with a bounded wait (configuration,
  *defaulted, reversible*). D0 Q6 saw the row after `agent start --resume` returned rc 0, but did
  not measure that registration precedes rc 0, so rc 0 is not the signal.
- **Order.** Each thread's buffer is FIFO. A message that arrives during a resume queues behind
  the buffer, and the buffer drains in order once the session is ready. Messages sent during a
  turn queue in Claude Code and are answered in order (Q4).
- **Reply timeout.** A turn with no reply within the reply timeout (configuration, *defaulted,
  reversible*) ends as "expert unavailable". A later reply to that message is dropped, not posted.

**Park and resume** (Q6; gate F4).

- **Park predicate:** no outstanding message without a reply, and the idle threshold has elapsed
  since the last reply. herdr's `idle` state alone never parks, because a session reads `idle` for
  about 1 s after a send (Q5). The idle threshold is configuration (*defaulted, reversible*).
- Parking is `pane close`: the process exits and its xmsg row disappears.
- On demand, `agent start … -- --resume <uuid>` in a new pane, under the thread's token, brings back
  the same `sessionId`, the same name and the conversation.
- A send to a parked thread returns 404 `not_found` and is not queued, so **the dispatcher buffers
  it**, resumes the thread, waits for readiness and then delivers.
- At **96h** idle, the transcript goes to the archiver (§6), and the entry and the transcript leave
  the tier's home. A later escalation of that thread starts fresh from its package.

**Tier drop** (row 14; gate F5). Each tier's dispatcher holds only its own map, under its own uid,
on its own bus. A thread that falls from trusted to public is routed to `@public` by the thread's
tier (C6, §5.1), and `@public` has never seen it, so it starts fresh, seeded only with the guarded
package. The tier never rises, so the thread never returns to `@trusted`. The pod round trip is the
other route, and it is closed separately: an `@trusted` reply that guard-out blocks is **dropped**
from tier 1's context and from the thread transcript, and archived with a tier label only, so it
never enters a later package, draft or replay (§4 step 6).

**Tokens** (rows 15–17; gate F3, F7).

- Every pool token is its own agenix secret, given to the tier's dispatcher by `LoadCredential`.
  `@trusted`'s pool is the owner's token. `@public`'s pool is the contributors' tokens plus the
  owner's token under its daily cap (row 16). Each token in each tier has its own config directory
  under that tier's home (row 17), so the owner's token in `@public` never shares a directory with
  the owner's token in `@trusted`.
- **Selection.** A new thread takes an `available` contributor token when one exists (*selection
  among them defaulted, reversible*), and otherwise the owner's token while its daily count of
  public escalations is under the cap. The thread keeps the token it started on.
- **States:** `available`, `exhausted-until(t)` and `removed`. Quota is not queryable in advance,
  so a token becomes `exhausted-until(t)` when a turn shows exhaustion (its appearance is measured
  by D4a), with `t` the reset the exhaustion reports. It becomes `available` again only when a turn
  at or after `t` succeeds; the reset is observed, never assumed. A token whose secret has left the
  pool is `removed`.
- **Unavailable, with no fallback.** A thread whose pinned token is `exhausted` or `removed`, and a
  new thread when no token is `available` (the owner's cap counts), gets "expert unavailable". No
  thread moves to another token, and no tier uses another tier's token. The second is held by
  construction, because I10.3 renders only the tier's own pool into its unit.
- **Channel to the pane.** Each pane gets only its own token. The dispatcher writes the thread's
  token to a per-thread file at mode 0400 in a per-thread directory. A shim reads it into
  `CLAUDE_CODE_OAUTH_TOKEN`, unlinks it and execs `claude`, and the dispatcher removes the directory
  when the thread parks. No token ever rides an argv, which would leave it in
  `/proc/<pid>/cmdline`, or the herdr server's environment, which every pane inherits.
- **Deny.** The tools are denied the whole credentials directory (`/run/credentials/**`), every
  per-thread token directory, `/run/agenix.d/**` and `/proc/*/environ` through both Bash and Read,
  and the variable is unset for sandboxed commands (I10's `credentials.envVars` deny). Whether
  Claude Code's own environment exposes the variable to the Bash tool is unmeasured. D4a step 0
  measures it, and oracle 30 holds either way.

**Prerequisites** (Q7; gate F10), owned by nix-config (I10.2). D0 rode on `sini`'s state, which a
fresh `genie-<tier>` config directory does not have:

- **onboarding** completed in each token's config directory;
- **workspace trust** for the tier's cwd, recorded per config directory (row 17 moves
  `.claude.json` with the directory). In an untrusted cwd, `agent start` stops on the
  workspace-trust dialog (`agent_not_ready`, launch blocked; measured red), and answering it by
  keys would have the dispatcher write `.claude.json` at runtime;
- **an explicit permission mode and allowlist** per tier, in which a tool outside the allowlist is
  refused rather than prompted, so no turn blocks on a prompt. The mode's name and behaviour as a
  non-`sini` user are I10.2's to measure;
- **the xmsg plugin**, with its MCP in reply-only mode and its hook that marks each inbound message
  with its `message_id`;
- **the per-token `--sessions-dir`** set on the tier's instance (X7);
- a **slim cwd** chosen for the tier, and `--model` set per tier (*defaulted, reversible*). A fresh
  session in a `den-ag-design` cwd started at 59,167 tokens (6.0%) on Opus 5.5, all of it
  CLAUDE.md, memory and hooks, and every thread would pay that baseline;
- **herdr's claude classifier manifest pinned** per tier. Parking and the watchdog hang on it, and
  D0 found it sourced remotely (`agent-detection/remote/claude.toml`).

**Within a tier** (gate P1). Per-thread sessions separate context windows, not storage: same-uid
sessions could read each other's transcripts. The tools are therefore denied every config
directory's `projects/` through Bash and Read (*defaulted, reversible*).

**A `blocked` pane mid-turn** (a permission prompt the allowlist failed to prevent; D0 did not
exercise one) fails the turn as "expert unavailable" and parks the thread (*defaulted,
reversible*). Nobody can answer the prompt.

**herdr's claude hook** reports outdated (v7 < v10). State detection scrapes the screen and does
not depend on it (Q1), so the dispatcher does not either.

**Rejected:**

- `claude -p` per message (row 14);
- API keys, and a fallback to another token or tier when quota runs out (row 15);
- a single resident session per tier, which is I10's tmux instance, because it mixes every thread
  of a tier into one context window (oracle 6);
- a private network namespace or nftables `meta skuid` rules on a shared loopback bus. Both fence a
  bus that is shared by default; row 18's per-user socket has no shared bus to fence;
- an anonymous HTTP dispatcher, which cannot receive (row 19 rejects arms (b) and (c) of the old
  open question 3; §11);
- the token in a `pane split --env` argument, or in the herdr server's environment (see Tokens).

## 6. Artifacts and retention (ruled: a shared mirror, per-thread state, a permanent archive)

- **Git mirror cache.** Bare mirrors keyed by repo URL on a Longhorn PVC. Only a trusted fetcher
  writes them, and eval Jobs never do. Each thread gets its own worktree. The mirror serves
  arbitrary user-supplied URLs, so it is fenced: a per-repo fetch-size cap aborts a fetch that
  passes it, and the PVC's size is the mirror's quota, held by evicting the least recently used
  mirror. Both values are configuration, set at P6/P7 (*defaulted, reversible*).
- **Thread state** (Longhorn). It holds that thread's transcript, tier and an eval-result cache
  keyed by `(repo, rev, attr, flags)`. It is never mounted into an eval Job.
- **Thread store** (Longhorn, RWO). The thread's own Nix store (fetched inputs, never shared across
  threads, because jobs write to it), mounted as the store root (§5.2 layer 4) only into that
  thread's eval Jobs, one at a time.
- Thread state and store are collected after **96h idle**, and resuming within that window
  remounts them. Resuming re-reads the transcript at ninfer's prefill rate (~1,050 tok/s): avoiding
  that would need KV-cache persistence in the engine, which is later work.
- **Permanent archive** (Garage S3, bucket `genie-transcripts`). Every transcript is written on
  close and on GC, together with the guard verdicts, escalation packages and broker actions.
  Purpose: training data, and reviving an expired thread by replaying its transcript into a fresh
  session. A replayed transcript passes guard-in before it seeds, as a recall does. The users'
  messages are public and the work is ours, so no retention notice is needed.
- **Expert transcripts** (gate F6). On bitstream, only the **archiver**, a root-run unit with no
  tier uid, holds an S3 key, and its key is write-only. It collects each tier's expired transcripts
  (§5.8) from the tier homes. `@public`'s go to `genie-transcripts` under an `expert/public/`
  prefix. `@trusted`'s carry private memory (row 13) and go to a separate bucket,
  `genie-expert-trusted` (*name defaulted, reversible*), which P5 never reads. No `genie-<tier>`
  process holds any S3 key.

## 7. Repository

`github:sini/genie-agent`, public, cloned at `~/Documents/repos/sini/genie-agent`.

```
prompts/   guard-in.md  guard-out.md  tier1.md  distiller.md
skills/    den/  gen/  nix-eval/  escalation/
schemas/   verdict.json  draft.json  escalation.json  eval-request.json  eval-result.json
           proposal.json  thread-state.json
support-memory/   the curated memory genie-expert@public reads (admitted by merged PR)
src/       supervisor, eval-launcher, escalation client, redactor   (TypeScript: pi's extension language)
nix/       package + OCI image (ghcr.io/sini/genie-agent)
ci/        nix-unit + the gen-harness evaluators
```

## 8. Units

The units, their status and their oracles are registered in the [plan](plan.md); this design
does not restate them.

## 9. Gating oracles

Each oracle has a RED-on-mutant run under `timeout`; a hang is not a RED.

01. **Injection corpus:** guard-in rejects or rewrites every attack case and passes every case in
    an allow control set.
02. **Redactor:** a planted credential of each in-scope shape (§5.2 layer 6) in an outbound answer
    never reaches the post, one case per shape. Mutant: redactor bypassed; and, per shape, that
    shape's pattern dropped.
03. **Resource fence:** an eval allocating 16Gi dies OOM in its own pod, and the node stays Ready.
    Mutant: the limit removed (run on a disposable node only).
04. **IFD gate:** an IFD eval is refused on the untrusted path and admitted on the trusted one.
    This tests the path; oracle 10 tests who may open it.
05. **Forced escalation:** a hard trigger escalates with no 🔍.
06. **Thread isolation:** a fact planted in thread A is absent from thread B's session.
07. **Broker custody:** no process except the broker can read the `genie-bot` token; a proposal
    that fails guard-out is never acted on. Mutant: the broker skips guard-out.
08. **No secret requests:** across a corpus of secret-blocked evals, no reply asks the user for a
    secret, and each one either works around the secret or names it as a blocker.
09. **Resume:** a thread resumed within 96h re-runs no eval whose cache key matches. Mutant: cache
    bypassed.
10. **Trust clamp:** a public thread whose tier 1 emits `trusted: true` gets an untrusted Job (no
    IFD, no builders, no builder key); a trusted thread with the request set gets a trusted one.
    Mutant: the launcher reads the model's flag alone.
11. **Thread tier:** a thread whose first message is from a public sender is public from that
    message; a trusted thread into which a public sender's text enters becomes public and stays
    public. Both are read from the raw envelope, before guard-in. Mutants: the tier is the
    originator's; the trigger line's tag hard-coded `trusted`.
12. **Poisoned history:** guard-in rejects or rewrites an injection carried in a thread-history
    line, not only in the latest message. Mutant: guard-in sees the latest message only.
13. **Eval egress:** from an eval Job, an allowlisted host is reachable and a non-allowlisted one
    is not. Mutant: the egress policy removed.
14. **Eval purity:** a fixture flake reading `builtins.getEnv`, `<nixpkgs>` or a path outside its
    inputs fails. Mutant: `pure-eval = false` (deleting the flag does not go red).
15. **Eval serialization:** two eval requests on one thread produce non-overlapping Jobs. Mutant:
    no per-thread lock.
16. **Mirror fence:** a fetch past the per-repo cap is aborted and leaves no mirror; filling past
    the quota evicts the least recently used mirror. Mutant: no cap; no eviction.
17. **Expert isolation**, four arms, each with its own unit: (a) a marker planted in sini's memory
    is unreadable from `genie-expert@public`, and each instance's mount table holds exactly one
    memory view; (b) a marker in an ignored file of an owner checkout, and a file of a private
    repository, are unreadable from `@public`; (c) a marker `@trusted` writes into `/tmp`, its
    `$HOME` and its config dir is unreadable from `@public` through both the Bash and the Read tool;
    (d) a public thread's package goes to `@public` whatever the package says. Mutants:
    `@public` mounts the private view; `@public` mounts an owner working tree; `PrivateTmp` off;
    route by a package field.
18. **Escalation guard:** an injection carried in `eval_transcript` is rejected or rewritten
    before the package leaves the pod. Mutant: the package sent unguarded.
19. **Seed guard:** an injection in a recalled bank entry or a replayed transcript passes guard-in
    before it seeds a session. Mutant: seed directly.
20. **Admission:** nothing enters the genie hindsight bank or the support memory without a human
    approval. A deterministic check can refuse a candidate and cannot admit one, and no model
    process can admit. Mutants: auto-admit; the deterministic check alone admits.
21. **Public admission:** with the admission option off, a public sender is dropped silently (as
    today); on, the message is passed with every line from that sender tagged `public`, the
    trigger line included; a trusted sender is tagged `trusted`. Mutants: every sender tagged
    `trusted`; the trigger line's tag hard-coded `trusted`.
22. **Untrusted Job mounts:** a rendered Job of effective trust untrusted mounts exactly the repo
    source (read-only), the thread store and the scratch `emptyDir`, and no Secret. Mutant: the
    thread-state volume added.
23. **Trusted Job mounts:** a rendered Job of effective trust trusted mounts those three plus the
    builder-key Secret, read-only. Mutants: the key omitted; the key mounted regardless of trust
    (oracle 22 goes red).
24. **Dispatcher core:** a second escalation of a parked thread launches with `--resume` and the
    uuid of its first launch, under the same token's config directory, including after the
    dispatcher is killed and restarted between the two. Mutants: always start fresh; an in-memory
    map.
25. **Blocked expert reply:** a marker in an `@trusted` reply that guard-out blocks is absent from
    the thread's later `@public` package, its draft and its replay, after the thread's tier falls.
    The fixture carries real content through the pod's round trip, not a contentless fake.
    Mutant: the blocked reply retained in tier 1's context.
26. **Expert park and GC:** with a fake clock, a thread with an outstanding message is never parked;
    with none, it is parked at the idle threshold after its last reply and stays resumable; at 95h
    idle it is kept, and at 96h it is handed to the archiver and gone. Mutants: never park; a TTL
    of 97h.
27. **Token pool:** a thread stays on the token it started on; a pinned token that is exhausted or
    removed answers "expert unavailable"; an exhausted token is selectable again after a turn at or
    after its reset succeeds; with no token available, a new thread gets "expert unavailable"; the
    owner's token in `@public` takes no turn past its daily cap; a contributor token is chosen
    before the owner's. Mutants: move the thread to another pool token; never re-admit after a
    reset; a removed pin keeps serving; no cap. Falling back to another tier's token is not a unit
    mutant, because the dispatcher holds only its own tier's pool; I10.3 guards it.
28. **Dispatcher delivery:** a message sent to a parked thread is buffered, delivered after the
    resumed uuid is listed by xmsg, and answered; two buffered messages and one arriving during the
    resume are delivered in order; a send within 1 s of a reply is never lost to a park; a retried
    send with the same key yields one turn; a dispatcher killed between a send and its reply still
    relays the reply; a turn with no reply within the timeout ends "expert unavailable". Mutants:
    forward to the parked uuid and drop on 404; deliver at `--resume` rc 0; park on herdr `idle`;
    retry without the key; an in-memory buffer.
29. **Bus fence:** from an `@public` thread session, through Bash and through its xmsg MCP, a
    connection to `@trusted`'s or `sini`'s xmsg socket is refused, and the MCP lists only `reply`.
    Positive control: the same session's reply over its own instance arrives. Mutants: the uid check
    removed; the MCP not in reply-only mode.
30. **Token custody:** from an `@public` thread session on token A, the bytes of pool token B and of
    token A are unreadable through Bash and Read. Mutant: the deny narrowed to one file.
31. **Expert archive custody:** no `genie-<tier>` unit's credential set holds an S3 key, and an
    `@trusted` expert transcript is written to `genie-expert-trusted` only, never to
    `genie-transcripts`. Mutants: the key in the `@public` dispatcher's unit; the `@trusted`
    transcript written to the shared bucket.

## 10. Not in scope

- Building users' configurations on the untrusted path.
- Running users' code (VM tests, scripts).
- Tier 1, or any model, acting with any credential: GitHub actions go through the broker.
- The frontier tier acting with sini's credentials: that is a proposal to sini.
- sini's private memory, a private repository or an owner working tree in any context that
  answers a public thread.
- API keys for the expert tier, `claude -p`, and any fallback between tokens or tiers (rows 14 and
  15).
- A shared xmsg bus between OS users on one host (row 18).

## 11. Open questions

1. **Where the support memory lives** (H0). **Ruled by the owner (2026-10-08): in the
   `genie-agent` repo.** It is a directory there, and a merged PR is the human admission
   (oracle 20). `genie-expert@public` reads it from the root-owned clean clone of `genie-agent`
   at its published revision (§5.2 layer 5), so a merged PR reaches it on the next sync and the
   owner's working tree never does.
2. **Volume placement.** A PVC is namespaced and Longhorn RWO binds one node, while the mirror and
   the worktrees are read by eval Jobs in `genie-eval` across nodes, and the thread store is
   per thread. Which namespace holds each volume, which access mode the mirror takes (RWX is not
   the house pattern: nix-config uses it only for the NFS media volumes), and whether the launcher's
   RBAC extends to per-thread PVCs are unsettled. Not picked here.
3. **The dispatcher's xmsg identity.** Ruled: row 19, arm (a), a `svc:` harness kind (X9). Arm
   (b), registering through pi's path, misattributes the harness. Arm (c), a Claude session as the
   dispatcher, pays the context baseline and puts a model in the routing path. Both are rejected.
4. **The owner's token in the public pool.** Ruled: row 16, yes, under a daily cap.
5. **One config directory per token, or one per tier.** Ruled: row 17, one per token (X7). The
   ruling's reason, "`--resume` needs that account's transcripts", is not re-opened. Transcripts
   are local files, and whether `--resume` consults the account at all is unmeasured; the pin's
   isolation between contributors holds whatever the answer is.

## 12. Gate disposition

| finding                             | resolved in                                                                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 trust is a model argument        | §4 step 3, §5.1, §5.3: the launcher clamps `trusted` to the thread's authenticated tier. Oracle 10, 11; units K3, E7, C7.                                                                                                               |
| F2 private memory to public threads | Row 13 (owner): two views, `genie-expert@public` / `@trusted`, never co-mounted, chosen by tier (§5.2 layer 5); the package guarded before Opus (§4 step 6); the redactor a backstop (§5.2). Oracles 17, 18; units H0, S5, C6, I13–I15. |
| F3 eval impurity                    | §5.2 layer 4: `--pure-eval`, empty `NIX_PATH` and registry, nothing from the thread state mounted; §6 splits thread state from thread store. Oracles 14, 22, 23; units E9, E10, E11.                                                    |
| F4 mirror unfenced                  | §6: per-repo fetch-size cap, PVC quota with LRU eviction. Oracle 16; units P6, P7.                                                                                                                                                      |
| F5 public admission unassigned      | §4 step 1: matrix-xmsg's admission option and per-line tier tag. Oracle 21; units M5c (admission), M5d (per-line tags).                                                                                                                 |
| F6 bank as injection channel        | §4 steps 2 and 7, §6: admission needs a human approval, and deterministic checks only refuse; recalls and replays pass guard-in. Oracles 19, 20; units S6, H2, H0.                                                                      |
| F7 credential shapes                | §5.2 layer 6 enumerates them; oracle 2 runs one case per shape. Unit S7.                                                                                                                                                                |
| F8 RWO store contention             | §4 step 3, §5.2 layer 4: one eval in flight per thread. Oracle 15; unit E8.                                                                                                                                                             |
| F9 missing oracles                  | (a) oracle 10; (b) oracle 12, unit S2's history class; (c) oracle 13, unit I3 (shipped by I2); (d) oracle 16.                                                                                                                           |
| F10 ninfer contention               | §4 "Latency": an accepted latency cost.                                                                                                                                                                                                 |

Second contact (`reports/genie-agent-design-gate-rev2.md` (private design repo)):

| finding                                            | resolved in                                                                                                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 trigger sender tagged `(trusted)`               | §4 step 1, §5.1: the supervisor reads the tier from the raw envelope, before guard-in. Oracles 11, 21; units C7 (public-originator cell), M5d.                                                     |
| R2 `@public` reads private repos and working trees | §5.2 layer 5: `@public` mounts only public repositories, as clean clones at the published revision; `@trusted` keeps the owner checkouts. *Defaulted, reversible.* Oracle 17(b); unit I14.         |
| R3 one uid, shared writable state                  | §5.2 layer 5: one uid per tier, `genie-public` and `genie-trusted` (built, I10), plus `PrivateTmp` and `ProtectSystem=strict` with the own home as the only writable path. Oracle 17(c); unit I15. |
| R4 "or deterministic" admits                       | §4 step 7: admission needs a human approval; deterministic checks only refuse. For the support memory, a merged PR in `genie-agent`. Oracle 20; units H0, H2.                                      |
| R5 builder key vs the mount property               | §5.3: the key is a Secret mounted only on clamped-trusted Jobs; the mount property splits by effective trust. Oracles 10, 22, 23; units E7, E10, E11.                                              |
| R6 one store or two                                | §5.2 layer 4: the thread store is the Job's store root; the `emptyDir` is scratch.                                                                                                                 |
| R7 unit ids and status                             | The plan's schema unit is K3 (K2 is a landed CI fix); statuses refreshed; §7's schema list matches the landed files.                                                                               |

Dispatcher gate (`reports/genie-dispatcher-design-gate.md` (private design repo)):

| finding                                | resolved in                                                                                                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 the shared xmsg bus                 | Row 18 (owner): a per-user unix-socket API and a reply-only session MCP; §5.8 Topology states the three nodes, their sockets and session dirs, the two re-cut links and the reply route. Oracle 29; units X8, I16.                                         |
| F2 dispatcher state not persisted      | §5.8 State and Units: a journal written before the acknowledgement, reconciliation on start, herdr in its own unit, and a pool change restarting only the dispatcher; §4 failure modes. Oracles 24 (restart cell), 28; units D1a, D1b, X9 (cursor on ack). |
| F3 the token channel and the deny      | §5.8 Tokens: a per-thread 0400 file and an unlinking shim, one token per pane; §5.2 layer 5 denies the whole credentials directory. D4a step 0 measures the Bash environment. Oracle 30; units D4a, D5.                                                    |
| F4 park and resume races               | §5.8 Talk and Park: the park predicate, readiness by xmsg listing, FIFO, idempotency keys, a reply timeout. Oracle 28; units D1b, X10.                                                                                                                     |
| F5 the blocked reply's return route    | §4 step 6 and §5.8 Tier drop: a blocked expert reply is dropped from tier 1's context and the transcript. Oracle 25 runs against content; unit C8. D2 is retired.                                                                                          |
| F6 the archive key on bitstream        | §6: a write-only key held only by a root-run archiver, and `@trusted` expert transcripts in a separate bucket that P5 never reads. Oracle 31; unit I17.                                                                                                    |
| F7 the token state machine             | §5.8 Tokens: `available`, `exhausted-until(t)`, `removed`, with the reset observed; a removed pin is unavailable. Oracle 27; unit D4b.                                                                                                                     |
| F8 atomicity and ordering              | D1 splits into D1a and D1b, and D4 into D4a and D4b; D1b, I10.2, I10.3 and D4b are gated on X7–X10 in the plan.                                                                                                                                            |
| F9 oracle discrimination               | Oracles 24–28 carry the named mutants, 95h/96h everywhere, and I10.3 adds the mutant "a contributor token in `@trusted`".                                                                                                                                  |
| F10 prerequisites D0 rode on as `sini` | §5.8 Prerequisites; I10.2's deliverable, and its oracle is one xmsg round trip as `genie-<tier>` on bitstream.                                                                                                                                             |
| P1 transcripts within a tier           | §5.8 Within a tier: the tools are denied every config directory's `projects/`.                                                                                                                                                                             |
| P2 the redactor's hash match           | §5.2 layer 6: pool tokens are matched by shape only.                                                                                                                                                                                                       |
| P3 herdr's remote classifier           | §5.8 Prerequisites: the manifest is pinned per tier (I10.2).                                                                                                                                                                                               |
