// The Kubernetes Job backend for the eval runner (plan E3, design §4 step 4, §5.2 layer 4).
// Renders the Job spec (gVisor runtimeClass, 12Gi/2c Guaranteed QoS, activeDeadlineSeconds 120,
// thread store volume as store root, scratch emptyDir limit, labels) and submits/watches it
// against the Kubernetes API in namespace `genie-eval`.
import { randomUUID } from "node:crypto";
import type { Runner } from "./lock.ts";
import {
  effectiveTier,
  fetchRefused,
  limitHit,
  nixArgv,
  TAIL_CHARS,
  type EvalResult,
  type Launch,
} from "./run.ts";

export interface K8sMetadata {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface K8sVolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}

export interface K8sVolume {
  name: string;
  persistentVolumeClaim?: { claimName: string; readOnly?: boolean };
  emptyDir?: { sizeLimit?: string };
  secret?: { secretName: string; defaultMode?: number };
}

export interface K8sResourceRequirements {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

export interface K8sContainer {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  resources?: K8sResourceRequirements;
  volumeMounts?: K8sVolumeMount[];
  env?: { name: string; value: string }[];
}

export interface K8sJobSpec {
  activeDeadlineSeconds?: number;
  backoffLimit?: number;
  template: {
    metadata?: {
      labels?: Record<string, string>;
    };
    spec: {
      runtimeClassName?: string;
      restartPolicy: "Never" | "OnFailure";
      containers: K8sContainer[];
      volumes?: K8sVolume[];
    };
  };
}

export interface K8sJobStatusCondition {
  type: "Complete" | "Failed" | "Suspended";
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
}

export interface K8sJobStatus {
  active?: number;
  succeeded?: number;
  failed?: number;
  startTime?: string;
  completionTime?: string;
  conditions?: K8sJobStatusCondition[];
}

export interface K8sJob {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: K8sMetadata;
  spec: K8sJobSpec;
  status?: K8sJobStatus;
}

export interface K8sContainerStatus {
  name: string;
  state?: {
    running?: { startedAt?: string };
    terminated?: {
      exitCode: number;
      reason?: string;
      message?: string;
    };
    waiting?: { reason?: string; message?: string };
  };
}

export interface K8sPod {
  metadata: K8sMetadata;
  status?: {
    phase?: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
    containerStatuses?: K8sContainerStatus[];
  };
}

export interface BuilderConfig {
  uri: string;
  system: string;
  maxJobs?: number;
  supportedFeatures?: string[] | string;
}

// Formats a Nix builder entry string from typed config and key path.
export function formatBuilderEntry(
  config: BuilderConfig,
  keyPath: string,
): string {
  const parts = [config.uri, config.system, keyPath];
  if (config.maxJobs !== undefined || config.supportedFeatures !== undefined) {
    parts.push(config.maxJobs !== undefined ? String(config.maxJobs) : "-");
  }
  if (config.supportedFeatures !== undefined) {
    parts.push("-"); // speed-factor
    const features = Array.isArray(config.supportedFeatures)
      ? config.supportedFeatures.join(",")
      : config.supportedFeatures;
    parts.push(features);
  }
  return parts.join(" ");
}

export interface RenderJobOptions {
  name?: string;
  namespace?: string;
  thread?: string;
  runtimeClassName?: string | null;
  activeDeadlineSeconds?: number;
  backoffLimit?: number;
  image?: string;
  scratchLimit?: string;
  storeClaimName?: string;
  storeMountPath?: string;
  scratchMountPath?: string;
  repoClaimName?: string;
  repoMountPath?: string;
  builderKeySecretName?: string;
  builderKeyMountPath?: string;
  builderKeyFileName?: string;
  builder?: BuilderConfig;
  builders?: string | BuilderConfig;
  localFlake?: string;
  labels?: Record<string, string>;
  env?: { name: string; value: string }[];
}

const tail = (s: string) => s.slice(-TAIL_CHARS);

const sanitise = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");

// Default guaranteed resource bounds: 12Gi memory and 2 cores (requests = limits).
export const DEFAULT_RESOURCES: K8sResourceRequirements = {
  requests: { cpu: "2", memory: "12Gi" },
  limits: { cpu: "2", memory: "12Gi" },
};

// Renders the Kubernetes Job manifest for one eval launch.
export function renderJob(launch: Launch, options: RenderJobOptions = {}): K8sJob {
  const { request } = launch;
  const thread = options.thread ?? "t";
  const name =
    options.name ?? `eval-${sanitise(thread)}-${randomUUID().slice(0, 8)}`;
  const namespace = options.namespace ?? "genie-eval";
  const flakeRef = options.localFlake
    ? "path:/src"
    : `github:${request.repo}/${request.rev}`;

  const labels: Record<string, string> = {
    "app.kubernetes.io/name": "genie-eval",
    "app.kubernetes.io/component": "eval",
    "genie.agent/thread": thread,
    "genie.agent/tier": launch.sender_tier,
    ...options.labels,
  };

  const runtimeClassName =
    options.runtimeClassName === null
      ? undefined
      : (options.runtimeClassName ?? "gvisor");

  const isTrusted = effectiveTier(launch) === "trusted";

  const repoVolumeName = "repo";
  const storeVolumeName = "thread-store";
  const scratchVolumeName = "scratch";
  const builderKeyVolumeName = "builder-key";

  const repoMountPath = options.repoMountPath ?? "/src";
  const storeMountPath = options.storeMountPath ?? "/thread-store";
  const scratchMountPath = options.scratchMountPath ?? "/tmp";
  const builderKeyMountPath = options.builderKeyMountPath ?? "/root/.ssh";
  const builderKeySecretName = options.builderKeySecretName ?? "builder-key";
  const builderKeyFileName = options.builderKeyFileName ?? "id_ed25519";
  const builderKeyPath = `${builderKeyMountPath}/${builderKeyFileName}`;

  const builderConfig =
    options.builder ??
    (typeof options.builders === "object" ? options.builders : undefined);

  const buildersArg = builderConfig
    ? formatBuilderEntry(builderConfig, builderKeyPath)
    : (typeof options.builders === "string" ? options.builders : undefined);

  // Nix eval arguments:
  // --store <mountPath> points to a local chroot store under the mounted PVC so fetched inputs persist
  // without shadowing the container image's /nix/store (where nix and its closure live).
  // max-jobs=0 keeps builds out of the pod (design §5.3).
  const nixArgs = [
    "--store",
    storeMountPath,
    "--option",
    "max-jobs",
    "0",
    ...nixArgv(launch, flakeRef, buildersArg),
  ];

  // Job mount set (plan E10, E11, design §5.2 layer 4, §5.3, §6):
  // untrusted: exactly repo source (read-only), thread store, and scratch emptyDir, with no Secret.
  // trusted: those three plus the builder-key Secret, read-only.
  const volumes: K8sVolume[] = [
    {
      name: repoVolumeName,
      persistentVolumeClaim: {
        claimName: options.repoClaimName ?? `repo-${thread}`,
        readOnly: true,
      },
    },
    {
      name: storeVolumeName,
      persistentVolumeClaim: {
        claimName: options.storeClaimName ?? `thread-store-${thread}`,
      },
    },
    {
      name: scratchVolumeName,
      emptyDir: {
        sizeLimit: options.scratchLimit ?? "10Gi",
      },
    },
    ...(isTrusted
      ? [
          {
            name: builderKeyVolumeName,
            secret: {
              secretName: builderKeySecretName,
              defaultMode: 0o400,
            },
          },
        ]
      : []),
  ];

  const volumeMounts: K8sVolumeMount[] = [
    {
      name: repoVolumeName,
      mountPath: repoMountPath,
      readOnly: true,
    },
    {
      name: storeVolumeName,
      mountPath: storeMountPath,
    },
    {
      name: scratchVolumeName,
      mountPath: scratchMountPath,
    },
    ...(isTrusted
      ? [
          {
            name: builderKeyVolumeName,
            mountPath: builderKeyMountPath,
            readOnly: true,
          },
        ]
      : []),
  ];

  const env = [
    { name: "HOME", value: "/tmp/home" },
    { name: "XDG_CACHE_HOME", value: "/tmp/cache" },
    { name: "NIX_PATH", value: "" },
    { name: "TMPDIR", value: "/tmp" },
    ...(isTrusted
      ? [
          {
            name: "NIX_SSHOPTS",
            value: `-o UserKnownHostsFile=${builderKeyMountPath}/known_hosts`,
          },
        ]
      : []),
    ...(options.env ?? []),
  ];

  const container: K8sContainer = {
    name: "eval",
    image: options.image ?? "ghcr.io/sini/genie-eval:latest",
    command: ["nix"],
    args: nixArgs,
    resources: DEFAULT_RESOURCES,
    volumeMounts,
    env,
  };

  const job: K8sJob = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace,
      labels,
    },
    spec: {
      activeDeadlineSeconds: options.activeDeadlineSeconds ?? 120,
      backoffLimit: options.backoffLimit ?? 0,
      template: {
        metadata: {
          labels,
        },
        spec: {
          ...(runtimeClassName !== undefined ? { runtimeClassName } : {}),
          restartPolicy: "Never",
          containers: [container],
          volumes,
        },
      },
    },
  };

  return job;
}

export interface K8sClientOptions {
  baseUrl: string;
  namespace?: string;
  token?: string;
  fetch?: typeof fetch;
}

export interface WatchJobOptions {
  namespace?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  cleanup?: boolean;
}

// Client for the namespaced Kubernetes batch and core APIs.
export class K8sClient {
  readonly baseUrl: string;
  readonly namespace: string;
  readonly token?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: K8sClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.namespace = options.namespace ?? "genie-eval";
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h["authorization"] = `Bearer ${this.token}`;
    return h;
  }

  async createJob(job: K8sJob): Promise<K8sJob> {
    const ns = job.metadata.namespace ?? this.namespace;
    const url = `${this.baseUrl}/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(job),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`k8s createJob failed (${res.status}): ${err}`);
    }
    return (await res.json()) as K8sJob;
  }

  async getJob(name: string, namespace?: string): Promise<K8sJob> {
    const ns = namespace ?? this.namespace;
    const url = `${this.baseUrl}/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(name)}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`k8s getJob failed (${res.status}): ${err}`);
    }
    return (await res.json()) as K8sJob;
  }

  async deleteJob(name: string, namespace?: string): Promise<void> {
    const ns = namespace ?? this.namespace;
    const url = `${this.baseUrl}/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(name)}?propagationPolicy=Background`;
    const res = await this.fetchFn(url, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      const err = await res.text().catch(() => "");
      throw new Error(`k8s deleteJob failed (${res.status}): ${err}`);
    }
  }

  async getPodsForJob(jobName: string, namespace?: string): Promise<K8sPod[]> {
    const ns = namespace ?? this.namespace;
    const selector = encodeURIComponent(`job-name=${jobName}`);
    const url = `${this.baseUrl}/api/v1/namespaces/${encodeURIComponent(ns)}/pods?labelSelector=${selector}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`k8s getPodsForJob failed (${res.status}): ${err}`);
    }
    const data = (await res.json()) as { items?: K8sPod[] };
    return data.items ?? [];
  }

  async getPodLogs(podName: string, namespace?: string): Promise<string> {
    const ns = namespace ?? this.namespace;
    const url = `${this.baseUrl}/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(podName)}/log`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`k8s getPodLogs failed (${res.status}): ${err}`);
    }
    return await res.text();
  }

  // Watches or polls the Job until it reaches Complete or Failed.
  async watchJob(name: string, options: WatchJobOptions = {}): Promise<K8sJob> {
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const start = Date.now();
    const ns = options.namespace ?? this.namespace;

    while (Date.now() - start < timeoutMs) {
      const job = await this.getJob(name, ns);
      const isComplete =
        job.status?.conditions?.some(
          (c) => c.type === "Complete" && c.status === "True",
        ) || (job.status?.succeeded ?? 0) > 0;
      const isFailed =
        job.status?.conditions?.some(
          (c) => c.type === "Failed" && c.status === "True",
        ) || (job.status?.failed ?? 0) > 0;
      if (isComplete || isFailed) {
        return job;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`k8s watchJob: timed out waiting for job ${name} after ${timeoutMs}ms`);
  }
}

// Submits a Job, watches it to completion, retrieves pod logs, classifies limits, and cleans up.
export async function submitAndWatchJob(
  client: K8sClient,
  job: K8sJob,
  options: WatchJobOptions = {},
): Promise<EvalResult> {
  const name = job.metadata.name;
  const ns = job.metadata.namespace ?? client.namespace;
  await client.createJob(job);
  try {
    const finished = await client.watchJob(name, { ...options, namespace: ns });
    const pods = await client.getPodsForJob(name, ns).catch(() => []);
    const pod = pods[0];
    const log = pod
      ? await client.getPodLogs(pod.metadata.name, ns).catch(() => "")
      : "";

    const deadline =
      finished.status?.conditions?.some(
        (c) => c.type === "Failed" && c.reason === "DeadlineExceeded",
      ) ?? false;

    const container =
      pod?.status?.containerStatuses?.find((c) => c.name === "eval") ??
      pod?.status?.containerStatuses?.[0];
    const term = container?.state?.terminated;
    const exit = deadline
      ? 124
      : (term?.exitCode ?? (finished.status?.succeeded ? 0 : 1));
    const reason = term?.reason ?? (deadline ? "DeadlineExceeded" : "");
    const oomKilled = reason === "OOMKilled" ? true : null;
    const sigkilled = exit === 137 || reason === "OOMKilled" || deadline;
    const isEgress = exit !== 0 && fetchRefused(log);

    const limit_hit = limitHit({
      deadline,
      sigkilled,
      oomKilled,
      fetchRefused: isEgress,
    });

    return {
      exit,
      stdout_tail: exit === 0 ? tail(log) : tail(log),
      stderr_tail: exit === 0 ? "" : tail(log),
      limit_hit,
    };
  } finally {
    if (options.cleanup !== false) {
      await client.deleteJob(name, ns).catch(() => {});
    }
  }
}

export interface K8sEvalOptions extends RenderJobOptions, WatchJobOptions {
  client?: K8sClient;
  k8s?: K8sClientOptions;
}

// Executes an eval launch against the Kubernetes backend.
export async function runK8sEval(
  launch: Launch,
  options: K8sEvalOptions = {},
): Promise<EvalResult> {
  const client =
    options.client ??
    new K8sClient(options.k8s ?? { baseUrl: "http://127.0.0.1:8080" });
  const job = renderJob(launch, options);
  return submitAndWatchJob(client, job, options);
}

// Wraps the Kubernetes backend as a Runner function matching E1's interface.
export function k8sRunner(options: K8sEvalOptions): Runner {
  return (launch: Launch) => runK8sEval(launch, options);
}
