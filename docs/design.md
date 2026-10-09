# Design: `genie-agent`, the tiered support expert behind `@genie`

_Owner brainstorm, 2026-10-08 (session `den-ag-design-44`). Every section below was approved in
that session. Where a choice is marked *defaulted, reversible*, the owner did not rule on it
explicitly._

## 1. Purpose

`@genie` answers den/gen/Nix support questions in Matrix rooms, including public ones. It is a
tiered expert. A local model fields every question first, and it escalates to a frontier model
when it cannot answer confidently or when the asker asks it to. It can reproduce a user's problem
by **evaluating** (never building) the user's GitHub configuration inside a sandbox, and no
user-supplied configuration can exhaust a host.

This design amends `genie-k8s-federation-plan.md` (private design repo). The bot and its first-tier expert move into
Kubernetes, and the frontier tier stays on a workstation as the user `genie`.

## 2. Rulings

| #   | question                       | ruling                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What "evaluate a config" means | **Eval only.** `nix eval` / `flake check --no-build`. We don't compile.                                                                                                                                                                                                                                           |
| 2   | Tier-1 model                   | Qwen 3.8 27B on ninfer (`cortex-cuda`). The design uses the measured **145,408-token shared pool** (`nix-config modules/den/hosts/cortex-cuda.nix:67`). The model, window and concurrency are **configuration**: a migration to Qwen 3.8 35B-A3B MoE (~1.5M context, or ~5 parallel agents) changes only numbers. |
| 3   | Where tier 1 runs              | **A k8s pod** (axon, ns `matrix`) beside matrix-xmsg and the xmsg leaf. cortex and bitstream are reserved for the Opus tier.                                                                                                                                                                                      |
| 4   | Frontier tier's access         | **A dedicated `genie` user, plus an approval channel.** It has read-only access to sini's `~/.claude` memories and the checkouts. Any action needing credentials becomes a proposal to sini.                                                                                                                      |
| 5   | Frontier tier's credential     | genie's **own** `claude setup-token` token (revocable on its own), not sini's credential file, which the tools cannot read. The owner added an LLM review layer (row 6) on top of this. *Defaulted, reversible.*                                                                                                  |
| 6   | Injection defence              | **A separate guard agent** reviews and reformats every inbound message and reviews every outbound answer. It runs on the **local Qwen** (the owner rates it at ~Opus 4.5–4.6), in separate sessions, in both directions.                                                                                          |
| 7   | When to escalate               | **Hard triggers force it; otherwise self-assessed confidence decides.** The self-assessment is **shown with the answer**, and the asker can **accept** or **request a deeper evaluation**.                                                                                                                        |
| 8   | Session lifetime               | **Per thread**, destroyed after acceptance or 24h idle. Accepted Q&A is distilled into a **dedicated genie hindsight bank**, with review before admission.                                                                                                                                                        |
| 9   | Eval sandbox                   | **One k8s Job per eval under gVisor** (`runtimeClassName: gvisor`), limits **12Gi / 2 cores**. **IFD** is off by default and allowed as a **trusted override**.                                                                                                                                                   |
| 10  | Trusted IFD builds             | Go to **remote builders**, including **uplink** (24 threads, 128GB), as a dedicated build user. *Hardening defaulted, reversible* (§5.4).                                                                                                                                                                         |
| 11  | Repo boundary                  | **genie-agent owns the agent, nix-config owns the deployment** (the matrix-xmsg pattern). The future target, once den runs on gen and gen-link exists, is for the repo to ship its own k8s shape.                                                                                                                 |
| 12  | Who builds                     | **Claude (Opus) gen-build agents.** Prompts and skills are critically reviewed against `writing-for-agents` and the existing quality skills. agy stays on xmsg and matrix-xmsg.                                                                                                                                   |

## 3. Components and flow

```
Matrix ─► matrix-xmsg ─► guard-in ─► tier-1 (per thread) ─────────────► guard-out ─► redactor ─► matrix-xmsg ─► Matrix
                                       │  eval-launcher → Job (gVisor)        ▲
                                       │  skills, docs, hindsight recall       │
                                       └─ escalate (🔍 / forced) ─► xmsg ─► Opus expert (user genie) ─┘
```

Every answer passes through guard-out and the redactor, tier 1's as well as Opus's.

- **genie-agent pod** (k8s, ns `matrix`): the containers `matrix-xmsg`, `xmsg` (leaf mode, X2) and
  `genie-agent`. In the last, the **supervisor** runs three kinds of pi process against ninfer:
  `guard-in`, a tier-1 session per thread, and `guard-out`. Each is a separate process with a
  separate context.
- **eval-launcher**: the only component with Kubernetes RBAC, limited to creating, watching and
  deleting Jobs in ns `genie-eval`.
- **Opus expert**: Claude Code as the OS user `genie` on a workstation. It receives the
  escalation package over xmsg federation.
- **distiller**: after an accept, it proposes a hindsight entry into the review queue.

## 4. Lifecycle of a request

1. **Intake.** matrix-xmsg receives a message from an allowed sender and passes it with thread
   context. guard-in returns `{verdict: allow|rewrite|reject, reason, cleaned_text}`. On reject,
   the bot posts a short refusal and tier 1 never sees the text.
2. **Session.** The supervisor finds or creates the thread's tier-1 session, seeding it with
   skills, a recall from the genie hindsight bank and the cleaned question.
3. **Work.** Tier 1 may call `eval {repo, rev, attr, trusted}` and receives
   `{exit, stdout_tail, stderr_tail, limit_hit: none|oom|timeout|egress}`.
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
6. **Escalation.** The package `{cleaned_question, draft, eval_transcript, gaps}` goes over xmsg
   to the Opus expert. Its answer returns through guard-out and the redactor and is posted in the
   thread, marked "expert review".
7. **Close.** On ✅, or after 24h idle, the transcript is archived and the session destroyed. On ✅
   the distiller proposes a hindsight entry, which is admitted only after review.

**Failure modes:**

- ninfer down or saturated: the bot says it is busy and queues the question. It never falls back
  to Opus on its own.
- xmsg unreachable during an escalation: the asker is told the expert is unavailable.
- An eval hits a limit: tier 1 reports which limit was hit, as a finding.

## 5. Trust, isolation and limits

### 5.1 Trust levels

- **Public sender:** guard-in; eval with IFD off.
- **Trusted MXID** (kanidm admins + `extraTrustedMxids`): 🔍 on any thread; the trusted-IFD path.
- **Opus expert:** receives only the guard-in-cleaned package, never raw Matrix text.

### 5.2 Layers

1. **Model:** guard-in and guard-out are separate sessions that never share context with tier 1
   or with each other.
2. **Process:** each pi session gets a tool allowlist. Tier 1 has `eval`, `recall`, `escalate` and
   `reply`, and **no shell**.
3. **Pod:** each credential is held only by the container that needs it: the Matrix token in the
   bot container, the leaf key in the xmsg container, and the launcher's namespaced RBAC. Egress is
   allowlisted to ninfer, the federation peers' `:7788` and the Matrix homeserver.
4. **Eval:** each eval runs as its own gVisor Job, starting from nothing, with:
   - 12Gi memory and 2 cores;
   - `activeDeadlineSeconds: 120`;
   - a size-limited `emptyDir` throwaway store;
   - `allow-import-from-derivation = false`, no builders and no substituters;
   - egress limited to fetching inputs (github.com, codeload.github.com, the nixpkgs
     channel/tarball hosts).
5. **Expert:** the OS user `genie`, with:
   - read-only bind mounts of `~sini/.claude/memory` and the den/gen/xmsg checkouts;
   - its own token in agenix, owned by `genie`, passed as `CLAUDE_CODE_OAUTH_TOKEN`, with the
     tools denied read of the secret path and of `/proc/*/environ` (Claude Code's bubblewrap
     sandbox);
   - no ssh agent, gh, kube or agenix identity.
6. **Output:** guard-out runs, then a deterministic redactor (token-shaped patterns plus a hash
   match against known secret files), and only then does anything post.

### 5.3 Trusted IFD

The trusted path adds `allow-import-from-derivation = true`, `builders` pointing at the remote
builders, and `cache.nixos.org` plus the builders' ssh port to the Job's egress. The Job keeps
`max-jobs = 0`, so nothing builds in-pod: IFD derivations build on the remote builders, under Nix's
own sandbox.

### 5.4 Remote builders (uplink first)

uplink is the edge host (FRR, the public nginx). Its builder role is *defaulted, reversible*:

- a dedicated `nix-remote-build` user with Nix's sandbox enforced;
- an ssh key admitted only from the `genie-eval` namespace's egress;
- a systemd slice capping CPU and memory, plus `max-jobs`, so builds cannot take capacity away
  from routing.

### 5.5 Network exposure

ninfer's reachability (today, a static route on the UniFi side) becomes explicit in nix-config's
terranix UniFi config, together with a Cilium CNP admitting only `genie-agent → ninfer:<port>`.

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

## 6. Artifacts and retention (ruled: a shared mirror, per-thread state, a permanent archive)

- **Git mirror cache.** Bare mirrors keyed by repo URL on a Longhorn PVC. Only a trusted fetcher
  writes them, and eval Jobs never do. Each thread gets its own worktree.
- **Thread PVC** (Longhorn). It holds that thread's transcript, its own Nix store (fetched
  inputs, never shared across threads, because jobs write to it) and an eval-result cache keyed by
  `(repo, rev, attr, flags)`. It is collected after **96h idle**, and resuming within that window
  remounts it. Resuming re-reads the transcript at ninfer's prefill rate (~1,050 tok/s): avoiding
  that would need KV-cache persistence in the engine, which is later work.
- **Permanent archive** (Garage S3, bucket `genie-transcripts`). Every transcript is written on
  close and on GC, together with the guard verdicts, escalation packages and broker actions.
  Purpose: training data, and reviving an expired thread by replaying its transcript into a fresh
  session. The users' messages are public and the work is ours, so no retention notice is needed.

## 7. Repository

`github:sini/genie-agent`, public, cloned at `~/Documents/repos/sini/genie-agent`.

```
prompts/   guard-in.md  guard-out.md  tier1.md  distiller.md
skills/    den/  gen/  nix-eval/  escalation/
schemas/   verdict.json  draft.json  escalation.json  eval.json
src/       supervisor, eval-launcher, escalation client, redactor   (TypeScript: pi's extension language)
nix/       package + OCI image (ghcr.io/sini/genie-agent)
ci/        nix-unit + the gen-harness evaluators
```

## 8. Units

| unit   | who                | what                                                                                                                                                     | needs  |
| ------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **G0** | Claude             | Spike: runsc as a k3s containerd shim plus a `gvisor` RuntimeClass on one axon node; a test Job; an eval Job hitting each limit (OOM, deadline, egress). | —      |
| **G1** | Opus gen-build     | Repo skeleton, schemas, redactor, eval-launcher (a local runner backend first, then k8s).                                                                | —      |
| **G2** | Opus gen-build     | Prompts and skills, critically reviewed against `writing-for-agents` and the quality skills.                                                             | G1     |
| **G3** | Opus gen-build     | Supervisor: per-thread sessions, lifecycle, escalation client.                                                                                           | G1     |
| **N3** | Claude, nix-config | ninfer exposure in terranix plus a CNP; runsc + RuntimeClass on the axons; the `genie-eval` namespace and RBAC.                                          | G0     |
| **N4** | Claude, nix-config | The `genie` user and Opus expert on a workstation; the uplink remote builder.                                                                            | X1, X2 |
| **M5** | agy                | matrix-xmsg: ✅/🔍 reactions, `!deeper`, the confidence line, the "expert review" post.                                                                  | —      |
| **H1** | Claude             | The genie hindsight bank and the distiller's review queue.                                                                                               | G3     |
| **G4** | Opus gen-build     | The action broker (gist, PR) with the `genie-bot` token held only by the broker.                                                                         | G1     |
| **G5** | Opus gen-build     | Artifacts: the mirror fetcher, the thread PVC lifecycle (96h GC), the S3 archive writer and replay-resume.                                               | G3     |
| **N5** | Claude, nix-config | The `genie-bot` token as a SopsSecret for the broker; Longhorn PVCs; the Garage bucket and its key.                                                      | G4, G5 |

## 9. Gating oracles

Each oracle has a RED-on-mutant run under `timeout`; a hang is not a RED.

1. **Injection corpus:** guard-in rejects or rewrites every attack case and passes every case in
   an allow control set.
2. **Redactor:** a planted token in an outbound answer never reaches the post. Mutant: redactor
   bypassed.
3. **Resource fence:** an eval allocating 16Gi dies OOM in its own pod, and the node stays Ready.
   Mutant: the limit removed (run on a disposable node only).
4. **IFD gate:** an IFD eval is refused on the untrusted path and admitted on the trusted one.
5. **Forced escalation:** a hard trigger escalates with no 🔍.
6. **Thread isolation:** a fact planted in thread A is absent from thread B's session.
7. **Broker custody:** no process except the broker can read the `genie-bot` token; a proposal
   that fails guard-out is never acted on. Mutant: the broker skips guard-out.
8. **No secret requests:** across a corpus of secret-blocked evals, no reply asks the user for a
   secret, and each one either works around the secret or names it as a blocker.
9. **Resume:** a thread resumed within 96h re-runs no eval whose cache key matches. Mutant: cache
   bypassed.

## 10. Not in scope

- Building users' configurations on the untrusted path.
- Running users' code (VM tests, scripts).
- Tier 1, or any model, acting with any credential: GitHub actions go through the broker.
- The frontier tier acting with sini's credentials: that is a proposal to sini.
