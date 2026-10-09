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

| #   | question                             | ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | What "evaluate a config" means       | **Eval only.** `nix eval` / `flake check --no-build`. We don't compile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | Tier-1 model                         | Qwen 3.8 27B on ninfer (`cortex-cuda`). The design uses the measured **145,408-token shared pool** (`nix-config modules/den/hosts/cortex-cuda.nix`, `maxContext`). The model, window and concurrency are **configuration**: a migration to Qwen 3.8 35B-A3B MoE (~1.5M context, or ~5 parallel agents) changes only numbers.                                                                                                                                                                                                                                                                           |
| 3   | Where tier 1 runs                    | **A k8s pod** (axon, ns `matrix`) beside matrix-xmsg and the xmsg leaf. cortex and bitstream are reserved for the Opus tier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | Frontier tier's access               | **A dedicated `genie` user, plus an approval channel.** It has read-only access to sini's `~/.claude` memories and the checkouts. Any action needing credentials becomes a proposal to sini.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | Frontier tier's credential           | genie's **own** `claude setup-token` token (revocable on its own), not sini's credential file, which the tools cannot read. The owner added an LLM review layer (row 6) on top of this. *Defaulted, reversible.* Amended by row 15: the credential is a per-tier pool of subscription tokens.                                                                                                                                                                                                                                                                                                          |
| 6   | Injection defence                    | **A separate guard agent** reviews and reformats every inbound message and reviews every outbound answer. It runs on the **local Qwen** (the owner rates it at ~Opus 4.5–4.6), in separate sessions, in both directions.                                                                                                                                                                                                                                                                                                                                                                               |
| 7   | When to escalate                     | **Hard triggers force it; otherwise self-assessed confidence decides.** The self-assessment is **shown with the answer**, and the asker can **accept** or **request a deeper evaluation**.                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8   | Session lifetime                     | **Per thread**, destroyed after acceptance or 24h idle. Accepted Q&A is distilled into a **dedicated genie hindsight bank**, with review before admission.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 9   | Eval sandbox                         | **One k8s Job per eval under gVisor** (`runtimeClassName: gvisor`), limits **12Gi / 2 cores**. **IFD** is off by default and allowed as a **trusted override**.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 10  | Trusted IFD builds                   | Go to **remote builders**, including **uplink** (24 threads, 128GB), as a dedicated build user. *Hardening defaulted, reversible* (§5.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 11  | Repo boundary                        | **genie-agent owns the agent, nix-config owns the deployment** (the matrix-xmsg pattern). The future target, once den runs on gen and gen-link exists, is for the repo to ship its own k8s shape.                                                                                                                                                                                                                                                                                                                                                                                                      |
| 12  | Who builds                           | **Claude (Opus) gen-build agents.** Prompts and skills are critically reviewed against `writing-for-agents` and the existing quality skills. agy stays on xmsg and matrix-xmsg.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 13  | Expert memory by tier (gate F2)      | **Trusted senders:** the expert reads sini's private memory; the risk is accepted, and trusting the user is the operational cost. **Public senders:** the expert reads only a curated, pre-redacted support memory, maintained separately, which also keeps the agent focused on the classes of task at hand. The authenticated sender tier selects the view, never a model, and the two views are never co-mounted. The gate's two fixes apply in both cases: the escalation package is guarded before Opus ingests it, and the redactor is a backstop. Realised in §5.1, §5.2 layer 5 and §4 step 6. |
| 14  | Expert lifecycle (owner, 2026-10-08) | **Option (c), on herdr, with no `claude -p`.** Each escalated thread is its own **interactive** Claude Code session in a pane of a per-tier herdr session, run as `genie-<tier>`. A small resident **dispatcher** per tier maps `thread_id` → Claude session id. Messages travel over xmsg; herdr does only the lifecycle: start, park (close the pane on idle) and resume (`--resume` in a new pane). **The tier only ever drops:** a thread that falls from trusted to public is never resumed in `@trusted`; it starts fresh in `@public`, seeded only with the guarded package. Realised in §5.8.  |
| 15  | Expert tokens (owner, 2026-10-08)    | **Subscription tokens only, never API keys.** When a token's quota runs out, that tier stops answering ("expert unavailable"), with **no fallback**. Each tier has a **token pool**: each contributor's subscription token is its own agenix secret; adding the file shares it, and `git rm` stops it. A thread is **pinned** to the token it started on (`--resume` needs that account's transcripts). Contributor tokens feed the **public** tier only; the owner's token serves `@trusted`. Contributors are told their quota answers public questions. Realised in §5.8.                           |

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
  session (row 14, §5.8).
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
   - its tier's token pool (row 15, §5.8), each token its own agenix secret, root-owned and read
     only by systemd (`LoadCredential`), exported to the thread's session as
     `CLAUDE_CODE_OAUTH_TOKEN`, with the
     tools denied read of the secret path and of `/proc/*/environ` (Claude Code's bubblewrap
     sandbox);
   - no ssh agent, gh, kube or agenix identity.
6. **Output:** guard-out runs, then a deterministic redactor (credential-shaped patterns plus a
   hash match against known secret files), and only then does anything post. The shapes it
   matches are those of the credentials in scope: the Matrix access token, every pool token
   (`CLAUDE_CODE_OAUTH_TOKEN`), the `genie-bot` fine-grained PAT (`github_pat_…`), the xmsg leaf
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

### 5.8 The expert dispatcher (rows 14 and 15)

Each tier runs one resident **dispatcher** as `genie-<tier>`, and it is what the address
`genie-expert@<tier>` names. It holds the map `thread_id → {session uuid, token, live|parked}` and
drives the tier's own herdr session. Messages travel only over xmsg; herdr does only the lifecycle.
The D0 spike measured the mechanism (`reports/genie-d0-herdr-spike.md` (private design repo): herdr 0.9.3, Claude Code
2.1.292 and xmsg 0.1.0 on cortex), and each step names the spike question that measured it.

- **Server** (Q2). `setsid herdr --session <tier> server` runs headless, with no client and no TTY.
  `herdr --session <tier> status` does not start a server. Every herdr command passes `--session <tier>` and runs with `HERDR_SOCKET_PATH` and the pane, tab and workspace variables unset;
  otherwise it reaches whatever session the environment names.
- **Launch** (Q1, Q3). The dispatcher mints a uuid first, then runs `herdr --session <tier> pane split … --cwd <tier cwd>` and `herdr --session <tier> agent start <n> --kind claude --pane <pane> -- -n <name> --session-id <uuid> [--model …]`. The uuid is the xmsg `sessionId`, the `--resume`
  key and the transcript name at once, so the dispatcher holds the address before the process
  exists and never discovers it. xmsg listed the session about 3 s after the start.
- **Talk** (Q4, Q5). The dispatcher forwards the guarded package to the thread's session over xmsg
  and relays the session's reply as its own reply to the supervisor's message. **The end of a turn
  is the xmsg reply**, read by long-polling `/v1/messages/{id}/replies?wait=…`. herdr state
  (`working`, `idle`, `blocked`) is only the liveness watchdog: a bare `herdr agent wait` returns
  at once on an idle session, and the server needs about 1 s to see a turn start, so it can return
  before the turn begins. Messages sent during a turn queue in Claude Code and are answered in
  order.
- **Park and resume** (Q6). On idle, `pane close` parks the thread: the process exits and its xmsg
  row disappears. On demand, `agent start … -- --resume <uuid>` in a new pane brings back the same
  `sessionId`, the same name and the conversation. A send to a parked thread returns 404
  `not_found` and is not queued, so **the dispatcher buffers it**, resumes the thread and then
  delivers. The idle threshold is configuration (*defaulted, reversible*). After 96h idle the
  transcript is archived and the entry dropped (§6), and a later escalation of that thread starts
  fresh from its package.
- **Tier drop** (row 14). Each tier's dispatcher holds only its own map, under its own uid. A thread
  that falls from trusted to public is routed to `@public` by the thread's tier (C6, §5.1), and
  `@public` has never seen it, so it starts fresh, seeded only with the guarded package. The tier
  never rises, so the thread never returns to `@trusted`.
- **Tokens** (row 15). Every pool token is its own agenix secret, given to the tier's dispatcher by
  `LoadCredential`. A new thread takes a token with quota left (*selection defaulted, reversible*)
  and keeps it. When the thread's token is exhausted, or when every token in the pool is exhausted
  for a new thread, the dispatcher replies "expert unavailable"; no thread moves to another token
  or another tier's token. A token reaches the session through `$CREDENTIALS_DIRECTORY` and the
  environment, never through an argv: a `pane split --env` argument would sit in the herdr
  client's `/proc/<pid>/cmdline`, which the same uid can read. That channel through the herdr
  server and into the pane is derived, not measured in D0. How exhaustion shows (screen state,
  error text) was not measured either; D4 measures both before its cell is written. Open question
  5 covers the config directory a token runs under.
- **Prerequisites** (Q7), owned by nix-config:
  - the tier's cwd is pre-trusted. In an untrusted cwd, `agent start` stops on the workspace-trust
    dialog (`agent_not_ready`, launch blocked; measured red), and answering it by keys would have
    the dispatcher write `~/.claude.json` at runtime;
  - the cwd is a slim directory chosen for the tier, and `--model` is set per tier (*defaulted,
    reversible*). A fresh session in a `den-ag-design` cwd started at 59,167 tokens (6.0%) on
    Opus 5.5, all of it CLAUDE.md, memory and hooks, and every thread would pay that baseline.
- **A `blocked` pane mid-turn** (a permission prompt, which D0 did not exercise) fails the turn as
  "expert unavailable" and parks the thread (*defaulted, reversible*). Nobody can answer the prompt.
- **herdr's claude hook** reports outdated (v7 < v10). State detection scrapes the screen and does
  not depend on it (Q1), so the dispatcher does not either.
- **Rejected:** `claude -p` per message (row 14); API keys (row 15); a fallback to another token or
  tier when quota runs out (row 15); a single resident session per tier, which is I10's tmux
  instance, because it mixes every thread of a tier into one context (oracle 6).

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
24. **Dispatcher resume:** a second escalation of a parked thread resumes the session it started
    (`--resume` with the minted uuid), and a message sent while the thread is parked is buffered
    and delivered after the resume, never lost to the 404. Mutant: always start fresh.
25. **Tier drop:** a thread escalated while trusted and again after its tier falls starts fresh in
    `@public`. A marker that the `@trusted` session held but never posted is absent from the
    `@public` seed and session. Mutant: resume across tiers.
26. **Expert park and GC:** with a fake clock, an idle thread is parked at the idle threshold and
    stays resumable; at 96h it is archived and gone, at 95h kept. Mutant: an off-by-a-unit TTL.
27. **Token pool:** a thread stays on the token it started on; when that token is exhausted, the
    reply is "expert unavailable"; with every pool token exhausted, a new thread gets the same.
    Mutants: fall back to another tier's token; move the thread to another token in the pool.

## 10. Not in scope

- Building users' configurations on the untrusted path.
- Running users' code (VM tests, scripts).
- Tier 1, or any model, acting with any credential: GitHub actions go through the broker.
- The frontier tier acting with sini's credentials: that is a proposal to sini.
- sini's private memory, a private repository or an owner working tree in any context that
  answers a public thread.
- API keys for the expert tier, `claude -p`, and any fallback between tokens or tiers (rows 14 and
  15).

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

3. **The dispatcher's xmsg identity.** D0 measured only its outbound half. An anonymous HTTP send
   works, and long-polling `/v1/messages/{id}/replies` reads the reply with no push, so a daemon
   can talk to its sessions (Q4a). The inbound half was not measured: the supervisor's escalation
   must reach an addressable principal named `genie-expert@<tier>` on that tier's xmsg instance.
   The HTTP API has no registration route (xmsg `a01b4f4`, `http.rs`: list, get, send, message and
   replies only). The non-Claude principals register over `register.sock`, and each is attested as
   its own harness (agy by a trusted executable and a presence lock, pi by argv and cwd, which
   README §1.3 calls a misconfiguration guard). The arms visible:

   - (a) a new xmsg harness kind for a resident daemon, attested the way agy is, by a trusted
     executable. This is xmsg work, in agy's lane;
   - (b) register through the pi path, which misattributes the harness and has to satisfy pi's
     argv check;
   - (c) a Claude Code session as the dispatcher, attested natively. It pays the context baseline
     (§5.8) and puts a model in the routing path that row 14 gives to a small resident process.

   Not picked here.

4. **The owner's token in the public pool.** Row 15 says contributor tokens feed public and the
   owner's token serves `@trusted`. It does not say whether the owner's token may also serve
   public, so a pool with no contributors leaves `@public` unavailable. This design reads it as
   no.

5. **One config directory per token, or one per tier.** Row 15 gives the pin's reason as
   "`--resume` needs that account's transcripts". That holds by construction only if each token
   runs under its own `CLAUDE_CONFIG_DIR`. But xmsg discovers Claude sessions from one session
   directory (`main.rs`: a single path, default `~/.claude/sessions`), so with a directory per
   token, xmsg would see the sessions of one directory only. The arms:

   - (a) one directory per tier. xmsg works as it is, and the dispatcher's map enforces the pin.
     Whether a token in the environment cleanly overrides a shared `.claude.json`'s account state
     is unmeasured;
   - (b) one directory per token. The pin holds by storage, and xmsg has to watch several session
     directories.

   Not picked here. Oracle 27 holds under either arm.

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
