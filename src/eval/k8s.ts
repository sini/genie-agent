import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import type { Runner } from "./lock.ts";
import {
  assertConfinedFlakeTree,
  effectiveTier,
  resolveWorktreeSubdir,
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
  subPath?: string;
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
      automountServiceAccountToken: false;
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
  namespace: string;
  image: string;
  storeClaimName: string;
  name?: string;
  runtimeClassName?: string | null;
  timeoutMs?: number;
  memoryMax?: number;
  cpu?: string;
  scratchLimit?: string;
  storeMountPath?: string;
  storeSubPath?: string;
  scratchMountPath?: string;
  repoClaimName?: string;
  repoMountPath?: string;
  repoSubPath?: string;
  worktreeRoot?: string;
  builderKeySecretName?: string;
  builderKeyMountPath?: string;
  builderKeyFileName?: string;
  builder?: BuilderConfig;
  builders?: string | BuilderConfig;
  labels?: Record<string, string>;
  env?: { name: string; value: string }[];
}

const tail = (s: string) => s.slice(-TAIL_CHARS);
export const sanitise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "t";
const threadName = /^(?!.*\.\.)[A-Za-z0-9_$!][A-Za-z0-9._:$!-]*$/;
const coordinate = /^[A-Za-z0-9._-]+$/;
const required = (value: string | undefined, name: string): string => {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Kubernetes ${name} is required`);
  return value;
};
const positive = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`invalid Kubernetes ${name}`);
  return value;
};
const prefix = (value: string | undefined): string => {
  if (value === undefined || value === "") return "";
  if (
    !value
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_.:-]+$/.test(part) && part !== "." && part !== "..",
      )
  )
    throw new Error("invalid Kubernetes subPath prefix");
  return `${value}/`;
};
const mountPath = (value: string, name: string): string => {
  if (
    !value.startsWith("/") ||
    value === "/" ||
    value.split("/").some((part) => part === "." || part === "..") ||
    value.includes("\0") ||
    value === "/nix/store" ||
    value.startsWith("/nix/store/")
  )
    throw new Error(`invalid Kubernetes ${name}`);
  return value.replace(/\/+$/, "");
};

export function renderJob(launch: Launch, options: RenderJobOptions): K8sJob {
  const { request } = launch;
  const thread = required(launch.thread, "thread");
  if (!threadName.test(thread)) throw new Error("invalid Kubernetes thread");
  const namespace = required(options.namespace, "namespace");
  const image = required(options.image, "image");
  const storeClaimName = required(options.storeClaimName, "storeClaimName");
  const safeThread = sanitise(thread);
  const name = options.name ?? `eval-${safeThread}-${randomUUID().slice(0, 8)}`;
  const storeSubPath = `${prefix(options.storeSubPath)}${thread}`;
  const sourcePrefix = prefix(options.repoSubPath);
  const repoMountPath = mountPath(
    options.repoMountPath ?? "/src",
    "repoMountPath",
  );
  const storeMountPath = mountPath(
    options.storeMountPath ?? "/thread-store",
    "storeMountPath",
  );
  const scratchMountPath = mountPath(
    options.scratchMountPath ?? "/tmp",
    "scratchMountPath",
  );
  if (new Set([repoMountPath, storeMountPath, scratchMountPath]).size !== 3)
    throw new Error("Kubernetes mount paths must be distinct");
  const timeoutMs = positive(options.timeoutMs ?? 120000, "timeoutMs");
  const memory =
    options.memoryMax !== undefined
      ? String(positive(options.memoryMax, "memoryMax"))
      : undefined;
  if (
    options.cpu !== undefined &&
    !/^(?:[1-9][0-9]*m|(?:[0-9]+)(?:\.[0-9]+)?)$/.test(options.cpu)
  )
    throw new Error("invalid Kubernetes cpu");
  if (options.cpu !== undefined && Number(options.cpu.replace(/m$/, "")) <= 0)
    throw new Error("invalid Kubernetes cpu");
  let flakeRef: string;
  const volumes: K8sVolume[] = [];
  const volumeMounts: K8sVolumeMount[] = [];
  if (request.worktreeSubdir !== undefined) {
    if (request.repo !== undefined || request.rev !== undefined)
      throw new Error("worktreeSubdir is mutually exclusive with repo and rev");
    const repoClaimName = required(options.repoClaimName, "repoClaimName");
    const worktreeRoot = required(options.worktreeRoot, "worktreeRoot");
    const source = resolveWorktreeSubdir(
      worktreeRoot,
      thread,
      request.worktreeSubdir,
    );
    const st = lstatSync(`${source}/flake.nix`, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.isSymbolicLink())
      throw new Error("worktreeSubdir has no regular flake.nix");
    assertConfinedFlakeTree(source, request.worktreeSubdir);
    const selected = relative(
      realpathSync(`${worktreeRoot}/${thread}`),
      source,
    );
    volumes.push({
      name: "repo",
      persistentVolumeClaim: { claimName: repoClaimName, readOnly: true },
    });
    volumeMounts.push({
      name: "repo",
      mountPath: repoMountPath,
      readOnly: true,
      subPath: `${sourcePrefix}${thread}/${selected}`,
    });
    flakeRef = `path:${encodeURI(repoMountPath).replaceAll("#", "%23").replaceAll("?", "%3F")}`;
  } else {
    const [owner, repo, ...rest] = (request.repo ?? "").split("/");
    if (
      rest.length ||
      ![owner, repo, request.rev].every((part) => coordinate.test(part ?? ""))
    )
      throw new Error("not a github coordinate");
    flakeRef = `github:${request.repo}/${request.rev}`;
  }
  const trusted = effectiveTier(launch) === "trusted";
  const builderKeyMountPath = mountPath(
    options.builderKeyMountPath ?? "/builder",
    "builderKeyMountPath",
  );
  const builderKeyFileName = options.builderKeyFileName ?? "key";
  if (
    !/^[A-Za-z0-9_.-]+$/.test(builderKeyFileName) ||
    [".", ".."].includes(builderKeyFileName)
  )
    throw new Error("invalid Kubernetes builderKeyFileName");
  const builderKeyPath = `${builderKeyMountPath}/${builderKeyFileName}`;
  const builderConfig =
    options.builder ??
    (typeof options.builders === "object" ? options.builders : undefined);
  const buildersArg = builderConfig
    ? formatBuilderEntry(builderConfig, builderKeyPath)
    : typeof options.builders === "string"
      ? options.builders
      : undefined;
  const mountBuilderKey = trusted && Boolean(buildersArg?.trim());
  volumes.push(
    {
      name: "thread-store",
      persistentVolumeClaim: { claimName: storeClaimName },
    },
    {
      name: "scratch",
      emptyDir: {
        ...(options.scratchLimit ? { sizeLimit: options.scratchLimit } : {}),
      },
    },
  );
  volumeMounts.push(
    { name: "thread-store", mountPath: storeMountPath, subPath: storeSubPath },
    { name: "scratch", mountPath: scratchMountPath },
  );
  if (mountBuilderKey) {
    volumes.push({
      name: "builder-key",
      secret: {
        secretName: required(
          options.builderKeySecretName,
          "builderKeySecretName",
        ),
        defaultMode: 0o400,
      },
    });
    volumeMounts.push({
      name: "builder-key",
      mountPath: builderKeyMountPath,
      readOnly: true,
    });
  }
  const labels = {
    ...options.labels,
    "app.kubernetes.io/name": "genie-eval",
    "app.kubernetes.io/component": "eval",
    "genie.agent/thread": safeThread,
    "genie.agent/tier": launch.sender_tier,
  };
  const resource = {
    ...(options.cpu ? { cpu: options.cpu } : {}),
    ...(memory ? { memory } : {}),
  };
  const env = [
    { name: "HOME", value: `${scratchMountPath}/home` },
    { name: "XDG_CACHE_HOME", value: `${scratchMountPath}/cache` },
    { name: "XDG_CONFIG_HOME", value: `${scratchMountPath}/config` },
    { name: "NIX_CONF_DIR", value: `${scratchMountPath}/conf` },
    { name: "NIX_PATH", value: "" },
    { name: "TMPDIR", value: scratchMountPath },
    ...(mountBuilderKey
      ? [
          {
            name: "NIX_SSHOPTS",
            value: `-o UserKnownHostsFile=${builderKeyMountPath}/known_hosts`,
          },
        ]
      : []),
  ];
  const reserved = new Set(env.map((item) => item.name));
  if (options.env?.some((item) => reserved.has(item.name)))
    throw new Error("Kubernetes environment overrides an evaluation setting");
  env.push(...(options.env ?? []));
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace, labels },
    spec: {
      activeDeadlineSeconds: Math.ceil(timeoutMs / 1000),
      backoffLimit: 0,
      template: {
        metadata: { labels },
        spec: {
          ...(options.runtimeClassName
            ? { runtimeClassName: options.runtimeClassName }
            : {}),
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          containers: [
            {
              name: "eval",
              image,
              command: ["nix"],
              args: [
                "--store",
                storeMountPath,
                "--option",
                "max-jobs",
                "0",
                ...nixArgv(launch, flakeRef, buildersArg),
              ],
              ...(Object.keys(resource).length
                ? { resources: { requests: resource, limits: { ...resource } } }
                : {}),
              volumeMounts,
              env,
            },
          ],
          volumes,
        },
      },
    },
  };
}

export interface K8sClientOptions {
  baseUrl: string;
  namespace?: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface WatchJobOptions {
  namespace?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  cleanup?: boolean;
  signal?: AbortSignal;
}

// Client for the namespaced Kubernetes batch and core APIs.
export class K8sClient {
  readonly baseUrl: string;
  readonly namespace: string;
  readonly token?: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: K8sClientOptions) {
    const api = new URL(required(options.baseUrl, "API baseUrl"));
    if (
      !["http:", "https:"].includes(api.protocol) ||
      api.username ||
      api.password
    )
      throw new Error("invalid Kubernetes API URL");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.namespace = required(options.namespace, "namespace");
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = positive(options.timeoutMs ?? 120000, "API timeoutMs");
    if (this.timeoutMs > 2147483647)
      throw new Error("invalid Kubernetes API timeoutMs");
  }

  private async request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(this.timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch {
      throw new Error("k8s API request failed");
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h["authorization"] = `Bearer ${this.token}`;
    return h;
  }

  async createJob(job: K8sJob, signal?: AbortSignal): Promise<K8sJob> {
    const ns = job.metadata.namespace ?? this.namespace;
    const url = `${this.baseUrl}/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs`;
    const res = await this.request(
      url,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(job),
      },
      signal,
    );
    if (!res.ok) {
      throw new Error(`k8s createJob failed (${res.status})`);
    }
    return (await res.json()) as K8sJob;
  }

  async getJob(
    name: string,
    namespace?: string,
    signal?: AbortSignal,
  ): Promise<K8sJob> {
    const ns = namespace ?? this.namespace;
    const url = `${this.baseUrl}/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(name)}`;
    const res = await this.request(
      url,
      {
        method: "GET",
        headers: this.headers(),
      },
      signal,
    );
    if (!res.ok) {
      throw new Error(`k8s getJob failed (${res.status})`);
    }
    return (await res.json()) as K8sJob;
  }

  async deleteJob(
    name: string,
    namespace?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const ns = namespace ?? this.namespace;
    const url = `${this.baseUrl}/apis/batch/v1/namespaces/${encodeURIComponent(ns)}/jobs/${encodeURIComponent(name)}?propagationPolicy=Background`;
    const res = await this.request(url, {
      method: "DELETE",
      headers: this.headers(),
    }, signal);
    if (!res.ok && res.status !== 404) {
      throw new Error(`k8s deleteJob failed (${res.status})`);
    }
  }

  async getPodsForJob(
    jobName: string,
    namespace?: string,
    signal?: AbortSignal,
  ): Promise<K8sPod[]> {
    const ns = namespace ?? this.namespace;
    const selector = encodeURIComponent(`job-name=${jobName}`);
    const url = `${this.baseUrl}/api/v1/namespaces/${encodeURIComponent(ns)}/pods?labelSelector=${selector}`;
    const res = await this.request(
      url,
      {
        method: "GET",
        headers: this.headers(),
      },
      signal,
    );
    if (!res.ok) {
      throw new Error(`k8s getPodsForJob failed (${res.status})`);
    }
    const data = (await res.json()) as { items?: K8sPod[] };
    return data.items ?? [];
  }

  async getPodLogs(
    podName: string,
    namespace?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const ns = namespace ?? this.namespace;
    const url = `${this.baseUrl}/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(podName)}/log?limitBytes=${TAIL_CHARS * 4}`;
    const res = await this.request(
      url,
      {
        method: "GET",
        headers: this.headers(),
      },
      signal,
    );
    if (!res.ok) {
      throw new Error(`k8s getPodLogs failed (${res.status})`);
    }
    if (!res.body) throw new Error("k8s getPodLogs returned no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let log = "";
    const append = (text: string) => {
      log = (log + text).slice(-TAIL_CHARS);
      const first = log.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) log = log.slice(1);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.length; offset += TAIL_CHARS * 4) {
          append(
            decoder.decode(value.subarray(offset, offset + TAIL_CHARS * 4), {
              stream: true,
            }),
          );
        }
      }
      append(decoder.decode());
      return log;
    } catch {
      await reader.cancel().catch(() => {});
      throw new Error("k8s getPodLogs stream failed");
    } finally {
      reader.releaseLock();
    }
  }

  // Watches or polls the Job until it reaches Complete or Failed.
  async watchJob(name: string, options: WatchJobOptions = {}): Promise<K8sJob> {
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const start = Date.now();
    const ns = options.namespace ?? this.namespace;

    while (Date.now() - start < timeoutMs) {
      const job = await this.getJob(name, ns, options.signal);
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
    throw new Error(
      `k8s watchJob: timed out waiting for job ${name} after ${timeoutMs}ms`,
    );
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
  const signal = AbortSignal.any([
    AbortSignal.timeout(positive(options.timeoutMs ?? 120000, "timeoutMs")),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    await client.createJob(job, signal);
    const finished = await client.watchJob(name, {
      ...options,
      namespace: ns,
      signal,
    });
    const pods = await client.getPodsForJob(name, ns, signal);
    const pod = pods[0];
    if (!pod) throw new Error("k8s completed Job has no observable pod");
    const log = await client.getPodLogs(pod.metadata.name, ns, signal);

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
      await client
        .deleteJob(name, ns, AbortSignal.timeout(5000))
        .catch(() => {});
    }
  }
}

export interface K8sEvalOptions
  extends RenderJobOptions,
    Omit<WatchJobOptions, "namespace"> {
  client?: K8sClient;
  k8s?: K8sClientOptions;
}

// Executes an eval launch against the Kubernetes backend.
export async function runK8sEval(
  launch: Launch,
  options: K8sEvalOptions,
): Promise<EvalResult> {
  const client =
    options.client ??
    (options.k8s
      ? new K8sClient({
          ...options.k8s,
          namespace: options.namespace,
          timeoutMs: options.timeoutMs ?? options.k8s.timeoutMs,
        })
      : undefined);
  if (!client) throw new Error("Kubernetes API must be configured");
  const job = renderJob(launch, options);
  return submitAndWatchJob(client, job, {
    ...options,
    timeoutMs: options.timeoutMs ?? 120000,
  });
}

// Wraps the Kubernetes backend as a Runner function matching E1's interface.
export function k8sRunner(options: K8sEvalOptions): Runner {
  return (launch: Launch) => runK8sEval(launch, options);
}
