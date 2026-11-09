# Configured executors

Root defaults to local execution. It detects usable Linux bwrap and delegated cgroups; otherwise it
runs the portable credential-custody baseline. An explicitly configured executor failure is an error,
and does not fall back to another executor. These adapters do not deploy anything.

## Separate container for Pi

The deployer supplies a command that starts `genie-container-worker` in a separate container and exposes
its stdin/stdout, plus a stop command that removes that instance. Commands are executable/argument arrays,
not shell text. `{instance}` is a fresh Root-generated identifier; `{socketDir}` is that thread's socket
directory. Root substitutes these literal tokens in arguments, never model input.

Only the socket directory is shared. Do not mount Root's configuration, credentials, worktrees or state
into the worker. Images provide immutable code/assets and operating memory. The worker uses a private
HOME, agent directory and session. File tools execute at Root under the existing thread confinement and
scratch quotas. Session transfers address the socket's captured thread, and reach Root before settlement
is forwarded, so archive and resume use Root's transcript.

Root configuration:

```json
{
  "tier1": {
    "executor": {
      "command": "podman",
      "args": ["run", "-i", "--name", "{instance}", "--mount", "type=bind,src={socketDir},dst=/run/genie,readonly", "--entrypoint", "/bin/genie-container-worker", "registry.example.org/agent:version"],
      "stop": {"command": "podman", "args": ["rm", "--force", "--ignore", "{instance}"]},
      "socketPath": "/run/genie/root.sock"
    }
  }
}
```

This illustrates a container engine adapter; no engine is a dependency of Genie. Supply the engine,
image and access suitable for the deployment. The launcher must preserve the worker protocol on stdout,
forward EOF, and keep the worker alive only for that launch. The stop command must be idempotent, stop
the remote instance and return success only after it has stopped. Root calls it on ordinary shutdown,
startup failure and forced termination. A failed cleanup is reported; Root cannot prove removal when
the external executor is unavailable. A container already running in a pod can use an equivalent
configured command/stop pair. Socket ownership/access is a deployment input; no UID is assumed.

Podman's [`rm --ignore`](https://docs.podman.io/en/latest/markdown/podman-rm.1.html) permits an already
absent instance; automatic removal is omitted so ordinary shutdown leaves removal to the stop command.

The same published root image includes the worker executable; override its entrypoint for the worker
container. Its ordinary entrypoint remains Root. A custom image may supply an image-local `pi` executable
and asset directory through `executor.pi` and `executor.repoRoot`.

## Kubernetes evaluation Jobs

Set `eval.backend` explicitly to `kubernetes`, and supply the API, namespace, evaluator image and storage.
Authentication is a Root-readable `tokenFile`; it is never sent to Pi or put in a Job. HTTPS uses Node's
normal trust configuration, including `NODE_EXTRA_CA_CERTS` supplied at Root startup where needed.

```json
{
  "eval": {
    "backend": "kubernetes",
    "timeoutMs": 120000,
    "memoryMax": 4294967296,
    "kubernetes": {
      "baseUrl": "https://api.example.org",
      "namespace": "chosen-namespace",
      "image": "registry.example.org/evaluator:version",
      "tokenFile": "/run/secrets/evaluator-api",
      "cpu": "2",
      "source": {"claimName": "chosen-source", "subPath": "worktrees"},
      "store": {"claimName": "chosen-store", "subPath": "stores"},
      "scratchLimit": "10Gi"
    }
  }
}
```

No runtime class is assumed. Set `runtimeClassName` only when the deployment provides one. The source
PVC prefix must correspond to Root's `mirror.worktreeRoot`; the Job mounts only the captured thread and
confined selected subdirectory, read-only. The store prefix must contain the per-thread directories.
Provision both mappings and their permissions before running. Repository/revision evaluations fetch
their validated coordinate and need no source volume. Job names/labels are identifiers, never storage
authority. Both ordinary and one-shot approved evals use the same configured backend and captured thread;
approval does not promote the thread's stored tier.

`timeoutMs` sets the Job deadline, rounded up to seconds, and bounds API waiting. `memoryMax` supplies the
memory resource limit in bytes; `cpu` supplies CPU requests/limits. These resources cover the Job, not
remote builders. Pure-eval and the existing trust/IFD rules remain. A builder Secret is mounted only for
an effective trusted eval with an explicitly configured builder and `builderKeySecretName`. It is never
mounted for an untrusted eval. Namespace permissions, image contents, source synchronization, network
policy and actual resource/runtime enforcement remain deployment responsibilities.

The Nix module exposes the same settings as `eval.backend`, `eval.kubernetes` and `tier1.executor`.
No Kubernetes cluster, runtime class, storage claim or container engine is created automatically.
