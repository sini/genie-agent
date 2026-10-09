# Plan: `genie-agent`, decomposed into parallel streams

_Implements the [design](design.md) (private design repo, c2be05701). The design gate
(`reports/genie-agent-design-gate.md`, private design repo) may amend units; this plan is revised to match its findings._

## Rules for every unit

- **Atomic:** one deliverable, one branch, one gating oracle with a RED-on-mutant run under
  `timeout` (a hang is not a RED). A unit that needs a second oracle is two units.
- **Reviewable:** a diff of ~≤400 lines, excluding lockfiles and corpora. The report gives the sha,
  test counts, the oracle-to-test map, the mutant output and anything unverified.
- **Local gate:** `nix develop ./ci --command ci` and `ci --tests-error` for genie-agent; the
  evaluation and `nixidy` render for nix-config units (one host per eval, MemoryMax=12G).
- **Prompt and skill units** are also reviewed against `writing-for-agents` and the quality skills
  before they land.
- **Owners:** genie-agent = Opus gen-build agents; nix-config = Claude agents; matrix-xmsg and
  xmsg = agy. The owner deploys and applies.

## The contract unit (everything in genie-agent forks from it)

| unit   | deliverable                                                                                                                                                                                                                        | oracle                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **K0** | Repo skeleton (`github:sini/genie-agent`, public), flake + `ci/` on gen-harness, and `schemas/`: `verdict`, `draft`, `eval-request`/`eval-result`, `escalation`, `proposal`, `thread-state`, each with valid and invalid fixtures. | Every fixture validates or fails as labelled. Mutant: loosen one `required`, and an invalid fixture passes ⇒ RED. |

After K0, streams **S, E, C, A, P** proceed in parallel. Streams **I** and **M** don't need K0 and
start immediately.

## Stream S: safety (genie-agent)

| unit | deliverable                                                                           | oracle                                                                                                                       | needs |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| S1   | Deterministic redactor: token-shape patterns plus a hash match on known secret files. | A planted token is gone from the output; a clean control passes byte-identical. Mutant: no-op.                               | K0    |
| S2   | Injection corpus: attack cases plus an allow control set, as data only.               | Lint: every case labelled, no duplicates, both sets non-empty. Mutant: drop a label.                                         | K0    |
| S3   | `guard-in` prompt + verdict parser.                                                   | On S2, every attack ⇒ reject/rewrite and every allow ⇒ allow (live against ninfer). Mutant: a prompt that allows everything. | S2    |
| S4   | `guard-out` prompt + an outbound corpus (leaks, secret requests, clean answers).      | Every leak and every secret request ⇒ block; clean ⇒ pass. Mutant: allow everything.                                         | S2    |

## Stream E: eval (genie-agent)

| unit | deliverable                                                                                                     | oracle                                                                                       | needs |
| ---- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----- |
| E1   | Local runner: `eval-request` → `nix eval` in bwrap with IFD off, no builders, no substituters → `eval-result`.  | An IFD expression is refused; a plain one evals. Mutant: IFD on.                             | K0    |
| E2   | Limit reporting: classify `oom`/`timeout`/`egress` into `limit_hit`.                                            | Three fixtures, each with the right class. Mutant: everything reported as `none`.            | E1    |
| E3   | k8s backend: render the Job spec (runtimeClass, 12Gi/2c, deadline, emptyDir limit, labels) and submit/watch it. | Snapshot plus property checks on the rendered spec. Mutant: drop `runtimeClassName`.         | E1    |
| E4   | The trusted IFD path: flags plus `builders`, gated on a trust bit.                                              | Untrusted ⇒ refused, trusted ⇒ the flags are present. Mutant: ignore the trust bit.          | E1    |
| E5   | Secret workaround: stub agenix/sops paths and placeholder secret attrs.                                         | A fixture flake reading an age secret evals with the stub. Mutant: no stub ⇒ the eval fails. | E1    |
| E6   | Eval-result cache keyed `(repo, rev, attr, flags)`.                                                             | A second identical request runs 0 evals. Mutant: cache bypassed.                             | E1    |

## Stream C: agent core (genie-agent)

| unit | deliverable                                                                       | oracle                                                                                                                             | needs |
| ---- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----- |
| C1   | pi tool surface: `eval`, `recall`, `escalate`, `reply`, `propose`, with no shell. | The tool list is exactly these five. Mutant: add `bash`.                                                                           | K0    |
| C2   | `tier1` prompt + skills skeleton (`den/`, `gen/`, `nix-eval/`, `escalation/`).    | Draft outputs on a small question set parse against `draft`, and include confidence and gaps. Mutant: drop the schema instruction. | C1    |
| C3   | Supervisor: one pi process per thread, with spawn and teardown.                   | A fact planted in thread A is absent from thread B. Mutant: one shared session.                                                    | C1    |
| C4   | Lifecycle: accept / 🔍 / 24h idle ⇒ close.                                        | A state-machine table test. Mutant: idle never closes.                                                                             | C3    |
| C5   | Escalation: forced triggers plus the package, sent over the xmsg API.             | A forced trigger sends with no 🔍; a below-threshold draft sends; a confident one doesn't. Mutant: ignore `escalate_forced`.       | C3    |

## Stream A: actions (genie-agent)

| unit | deliverable                                                                               | oracle                                                                | needs  |
| ---- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| A1   | Broker core: proposal intake → guard-out → redactor → act. Token read only by the broker. | A proposal failing guard-out is not acted on. Mutant: skip guard-out. | K0, S1 |
| A2   | Gist action (against a GitHub API stub).                                                  | A gist proposal produces exactly one create call. Mutant: zero calls. | A1     |
| A3   | PR action: fork, branch, commit, PR (stubbed), with the thread link in the body.          | One PR with the thread link. Mutant: drop the link.                   | A1     |

## Stream P: persistence (genie-agent)

| unit | deliverable                                                                                 | oracle                                                                    | needs  |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| P1   | Mirror fetcher: bare mirrors keyed by URL, plus a worktree per thread.                      | Two threads on one repo ⇒ one clone. Mutant: clone per thread.            | K0     |
| P2   | Thread-state store on a path (the PVC in prod): transcript, store dir, cache.               | Restart, then resume ⇒ the same transcript. Mutant: state written to tmp. | K0     |
| P3   | 96h idle GC.                                                                                | Fake clock: at 95h kept, at 97h gone. Mutant: an off-by-a-unit TTL.       | P2     |
| P4   | S3 archive writer (against a Garage/minio stub): transcript, verdicts, escalation, actions. | Close ⇒ one object holding all four sections. Mutant: omit verdicts.      | P2     |
| P5   | Replay-resume of an expired thread from the archive.                                        | A GC'd thread resumes with the same transcript. Mutant: start fresh.      | P4, C3 |

## Stream H: knowledge (Claude)

| unit | deliverable                                                                           | oracle                                                                                                              | needs  |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| H1   | genie hindsight bank, created with its own config.                                    | Recall from it returns its seed entry and nothing from `den-law`. Positive control: the same query on den-law hits. | —      |
| H2   | Distiller prompt plus a review queue. Nothing is written to the bank before approval. | Accept ⇒ the queue grows by 1 and the bank by 0; approve ⇒ the bank grows by 1. Mutant: write directly.             | H1, C4 |

## Stream I: infrastructure (nix-config, Claude)

| unit | deliverable                                                                                | oracle                                                                                                        | needs                     |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------- |
| I1   | runsc as a k3s containerd shim + a `gvisor` RuntimeClass on **one** axon node.             | A pod under gvisor reports the gVisor kernel (`dmesg`); a runc control does not.                              | —                         |
| I2   | ns `genie-eval`: ServiceAccount, Role (Jobs only), LimitRange, ResourceQuota.              | `kubectl auth can-i`: create jobs in genie-eval ⇒ yes; in matrix or for secrets ⇒ no.                         | —                         |
| I3   | Eval egress CNP.                                                                           | From a gvisor test pod, github.com is reachable and example.com is not.                                       | I1, I2                    |
| I4   | The resource fence on the I1 node.                                                         | A 16Gi allocator Job dies OOMKilled while the node stays Ready.                                               | I1, I2                    |
| I5   | runsc on the remaining axon nodes.                                                         | I1's oracle on each node.                                                                                     | I4                        |
| I6   | ninfer exposure explicit in terranix UniFi + nftables on cortex-cuda.                      | `unifi-plan` shows the route/rule; the port is reachable from an axon and refused from an outside host.       | —                         |
| I7   | CNP: genie-agent → ninfer only.                                                            | Reachable from the genie pod, blocked from a sibling pod.                                                     | I6                        |
| I8   | uplink remote builder: `nix-remote-build` user, sandbox, slice cap, restricted key.        | A test build from the key succeeds; the same key cannot get a shell; the slice's `MemoryMax` is set.          | —                         |
| I9   | Longhorn PVCs (mirror, thread) + the Garage bucket `genie-transcripts` and its key.        | PVCs Bound; an S3 put/get round-trips with the key.                                                           | —                         |
| I10  | `genie` user + Opus expert on a workstation: read-only mounts, own token, bubblewrap deny. | Inside the expert, reading the token path and `/proc/*/environ` fails, and reading memory/checkouts succeeds. | —                         |
| I11  | `genie-bot` token as a SopsSecret mounted only into the broker container.                  | A rendered manifest shows the secret only in the broker container.                                            | owner creates the account |
| I12  | The genie-agent deployment (nixidy): containers, mounts, egress, image pin.                | `nixidy` render plus a manifest property test.                                                                | K0 image, I2, I7, I9, I11 |

## Stream M: bot (matrix-xmsg, agy)

| unit | deliverable                                                                                               | oracle                                                                                  | needs |
| ---- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----- |
| M5a  | Reactions ✅/🔍 on the bot's message, plus a `!deeper` fallback; only the asker or a trusted MXID counts. | 🔍 from a stranger is ignored; from the asker it emits an event. Mutant: accept anyone. | —     |
| M5b  | Rendering: the answer plus the confidence line and gaps, and the "expert review" label.                   | Snapshot. Mutant: drop the confidence line.                                             | —     |

## Federation (already in flight, agy)

X1 gate → X2 leaf + M4 images. C5's live path and I10's escalation path need them, but every unit
above tests against the xmsg API locally, so nothing waits on federation until integration.

## Integration (last, owner-run)

**J1**, live in `#support` with the trusted MXIDs only. A question flows guard-in → tier 1 → eval
Job → answer + confidence → 🔍 → Opus → guard-out → post → ✅ → archive + distiller queue. Then
the owner opens to the public rooms.

## Parallel lanes at a glance

```
day 0 : K0 │ I1 I2 I6 I8 I9 I10 │ M5a M5b │ H1
after K0: S1 S2 E1 C1 P1 P2   (6 independent)
then    : S3 S4 │ E2–E6 │ C2 C3 → C4 C5 │ A1 → A2 A3 │ P3 P4 → P5 │ I3 I4 → I5, I7, I11 → I12 │ H2
last    : J1
```
