// The Kubernetes Job backend for the eval runner (plan E3, design §4 step 4, §5.2 layer 4).
// Oracle: snapshot plus property checks on the rendered Job spec.
// Tests submit and watch against a stub Kubernetes HTTP API server.
// Run with `node --test tests/eval-k8s.test.ts`.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { perThread } from "../src/eval/lock.ts";
import {
  DEFAULT_RESOURCES,
  K8sClient,
  k8sRunner,
  renderJob,
  repoSourceMount,
  repoSourceVolume,
  runK8sEval,
  submitAndWatchJob,
  type K8sJob,
  type K8sPod,
  type K8sVolume,
  type K8sVolumeMount,
} from "../src/eval/k8s.ts";
import type { Launch } from "../src/eval/run.ts";

const sampleLaunch: Launch = {
  request: {
    repo: "owner/repo",
    rev: "main",
    attr: "package",
    trusted: "no",
  },
  sender_tier: "public",
};

const trustedLaunch: Launch = {
  request: {
    repo: "owner/repo",
    rev: "main",
    attr: "package",
    trusted: "yes",
  },
  sender_tier: "trusted",
};

const SNAPSHOT: K8sJob = {
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: {
    name: "eval-t1-test",
    namespace: "genie-eval",
    labels: {
      "app.kubernetes.io/name": "genie-eval",
      "app.kubernetes.io/component": "eval",
      "genie.agent/thread": "t1",
      "genie.agent/tier": "public",
    },
  },
  spec: {
    activeDeadlineSeconds: 120,
    backoffLimit: 0,
    template: {
      metadata: {
        labels: {
          "app.kubernetes.io/name": "genie-eval",
          "app.kubernetes.io/component": "eval",
          "genie.agent/thread": "t1",
          "genie.agent/tier": "public",
        },
      },
      spec: {
        runtimeClassName: "gvisor",
        restartPolicy: "Never",
        containers: [
          {
            name: "eval",
            image: "ghcr.io/sini/genie-eval:latest",
            command: ["nix"],
            args: [
              "--store",
              "/thread-store",
              "--option",
              "max-jobs",
              "0",
              "--extra-experimental-features",
              "nix-command flakes",
              "--option",
              "pure-eval",
              "true",
              "--option",
              "allow-import-from-derivation",
              "false",
              "--option",
              "builders",
              "",
              "--option",
              "substituters",
              "",
              "--option",
              "accept-flake-config",
              "false",
              "--option",
              "flake-registry",
              "",
              "--option",
              "connect-timeout",
              "5",
              "eval",
              "github:owner/repo/main#package",
              "--no-write-lock-file",
            ],
            resources: {
              requests: {
                cpu: "2",
                memory: "12Gi",
              },
              limits: {
                cpu: "2",
                memory: "12Gi",
              },
            },
            volumeMounts: [
              {
                name: "thread-store",
                mountPath: "/thread-store",
              },
              {
                name: "scratch",
                mountPath: "/tmp",
              },
            ],
            env: [
              { name: "HOME", value: "/tmp/home" },
              { name: "XDG_CACHE_HOME", value: "/tmp/cache" },
              { name: "NIX_PATH", value: "" },
              { name: "TMPDIR", value: "/tmp" },
            ],
          },
        ],
        volumes: [
          {
            name: "thread-store",
            persistentVolumeClaim: {
              claimName: "thread-store-t1",
            },
          },
          {
            name: "scratch",
            emptyDir: {
              sizeLimit: "10Gi",
            },
          },
        ],
      },
    },
  },
};

// Verifies that a Job spec conforms to all required architectural properties.
function assertJobProperties(job: K8sJob, expectedThread = "t1", expectedTier = "public"): void {
  // 1. RuntimeClass is gVisor
  assert.equal(
    job.spec.template.spec.runtimeClassName,
    "gvisor",
    "runtimeClassName must be gvisor",
  );

  // 2. Guaranteed QoS: 12Gi / 2 cores with request = limit
  const container = job.spec.template.spec.containers[0];
  assert.ok(container, "job must define at least one container");
  assert.equal(container.name, "eval");
  assert.equal(container.resources?.requests?.cpu, "2", "CPU request must be 2");
  assert.equal(container.resources?.requests?.memory, "12Gi", "memory request must be 12Gi");
  assert.equal(container.resources?.limits?.cpu, "2", "CPU limit must be 2");
  assert.equal(container.resources?.limits?.memory, "12Gi", "memory limit must be 12Gi");
  assert.deepEqual(
    container.resources?.requests,
    container.resources?.limits,
    "requests must equal limits (Guaranteed QoS)",
  );

  // 3. Deadline and restart policy
  assert.equal(job.spec.activeDeadlineSeconds, 120, "activeDeadlineSeconds must be 120");
  assert.equal(job.spec.backoffLimit, 0, "backoffLimit must be 0");
  assert.equal(job.spec.template.spec.restartPolicy, "Never", "restartPolicy must be Never");

  // 4. Thread store volume mounted at a separate path, never shadowing image's /nix/store
  const volumes = job.spec.template.spec.volumes ?? [];
  const mounts = container.volumeMounts ?? [];
  const storeVol = volumes.find((v) => v.name === "thread-store");
  assert.ok(storeVol, "thread-store volume must exist");
  assert.equal(
    storeVol.persistentVolumeClaim?.claimName,
    `thread-store-${expectedThread}`,
    "thread-store PVC claimName must match thread",
  );
  // Property check: no volumeMount at /nix/store (would shadow image closure)
  assert.ok(
    !mounts.some((m) => m.mountPath === "/nix/store"),
    "must not mount volume at /nix/store to prevent shadowing image closure",
  );
  const storeMount = mounts.find((m) => m.name === "thread-store");
  assert.ok(storeMount, "thread-store volumeMount must exist");
  assert.equal(storeMount.mountPath, "/thread-store", "thread-store must be mounted at /thread-store");

  // Property check: argv carries --store <mountPath> matching the PVC mount
  const storeArgIdx = container.args?.indexOf("--store") ?? -1;
  assert.notEqual(storeArgIdx, -1, "argv must carry --store");
  assert.equal(
    container.args?.[storeArgIdx + 1],
    storeMount.mountPath,
    "argv --store must match thread-store mountPath",
  );

  // 5. Scratch emptyDir limit
  const scratchVol = volumes.find((v) => v.name === "scratch");
  assert.ok(scratchVol, "scratch volume must exist");
  assert.equal(scratchVol.emptyDir?.sizeLimit, "10Gi", "scratch sizeLimit must be 10Gi");
  const scratchMount = mounts.find((m) => m.name === "scratch");
  assert.ok(scratchMount, "scratch volumeMount must exist");
  assert.equal(scratchMount.mountPath, "/tmp", "scratch must be mounted at /tmp");

  // 6. Labels on Job and pod template
  assert.equal(job.metadata.namespace, "genie-eval");
  assert.equal(job.metadata.labels?.["app.kubernetes.io/name"], "genie-eval");
  assert.equal(job.metadata.labels?.["app.kubernetes.io/component"], "eval");
  assert.equal(job.metadata.labels?.["genie.agent/thread"], expectedThread);
  assert.equal(job.metadata.labels?.["genie.agent/tier"], expectedTier);
  assert.deepEqual(
    job.metadata.labels,
    job.spec.template.metadata?.labels,
    "pod template labels must mirror Job labels",
  );

  // 7. Nix command options: max-jobs=0, pure-eval, connect-timeout, and untrusted builders/substituters
  assert.deepEqual(container.command, ["nix"]);
  const args = container.args ?? [];
  const maxJobsIdx = args.indexOf("max-jobs");
  assert.notEqual(maxJobsIdx, -1, "argv must configure max-jobs");
  assert.equal(args[maxJobsIdx + 1], "0", "max-jobs must be 0");

  const buildersIdx = args.indexOf("builders");
  assert.notEqual(buildersIdx, -1, "argv must configure builders");
  if (expectedTier === "public") {
    assert.equal(args[buildersIdx + 1], "", "untrusted launch must configure no builders");
  }

  const substitutersIdx = args.indexOf("substituters");
  assert.notEqual(substitutersIdx, -1, "argv must configure substituters");
  assert.equal(args[substitutersIdx + 1], "", "launch must configure no substituters");

  assert.ok(args.includes("pure-eval"));
  assert.ok(args.includes("connect-timeout"));

  // 8. General isolation: thread-state volume must never mount in any eval Job (design §5.2 layer 4, §6)
  assert.ok(
    !volumes.some(
      (v) =>
        v.name.includes("thread-state") ||
        v.persistentVolumeClaim?.claimName.includes("thread-state"),
    ) &&
      !mounts.some(
        (m) =>
          m.name.includes("thread-state") ||
          m.mountPath.includes("state"),
      ),
    "thread-state volume must never mount in eval Job",
  );

  // 9. Untrusted launch must not mount any Secret (gate R5, design §5.2 layer 4)
  if (expectedTier === "public") {
    assert.ok(
      !volumes.some((v) => v.secret !== undefined),
      "untrusted Job must not mount any Secret",
    );
  }
}

// Oracle 22 (plan E10, design §5.2 layer 4, §6):
// Untrusted Job mount set: exactly the repo source (read-only), the thread store,
// and the scratch emptyDir, with no Secret. The thread-state volume never mounts.
export function assertUntrustedJobMounts(job: K8sJob): void {
  const volumes = job.spec.template.spec.volumes ?? [];
  const mounts = job.spec.template.spec.containers[0]?.volumeMounts ?? [];

  // Invariant 1: thread-state volume never mounts (design §5.2 layer 4, §6)
  const hasThreadStateVol = volumes.some(
    (v) =>
      v.name.includes("thread-state") ||
      v.persistentVolumeClaim?.claimName.includes("thread-state"),
  );
  const hasThreadStateMount = mounts.some(
    (m) =>
      m.name.includes("thread-state") ||
      m.mountPath.includes("state"),
  );
  assert.ok(
    !hasThreadStateVol && !hasThreadStateMount,
    "thread-state volume must never mount in eval Job",
  );

  // Invariant 2: untrusted Job must not mount any Secret (gate R5, design §5.2 layer 4)
  assert.ok(
    !volumes.some((v) => v.secret !== undefined),
    "untrusted Job must not mount any Secret",
  );

  // Invariant 3: Exactly three volumes and three volumeMounts
  assert.equal(
    volumes.length,
    3,
    `untrusted Job must have exactly 3 volumes (repo source, thread store, scratch emptyDir), found ${volumes.length}`,
  );
  assert.equal(
    mounts.length,
    3,
    `untrusted Job must have exactly 3 volumeMounts, found ${mounts.length}`,
  );

  // Invariant 4: Thread store volume (PVC) mounted at /thread-store, not /nix/store
  const storeVol = volumes.find((v) => v.name === "thread-store");
  assert.ok(storeVol, "thread-store volume must exist");
  assert.ok(storeVol.persistentVolumeClaim, "thread-store volume must be a PVC");
  const storeMount = mounts.find((m) => m.name === "thread-store");
  assert.ok(storeMount, "thread-store volumeMount must exist");
  assert.equal(storeMount.mountPath, "/thread-store", "thread-store must be mounted at /thread-store");
  assert.ok(!mounts.some((m) => m.mountPath === "/nix/store"), "must not mount volume at /nix/store");

  // Invariant 5: Scratch emptyDir volume mounted at /tmp
  const scratchVol = volumes.find((v) => v.name === "scratch");
  assert.ok(scratchVol, "scratch volume must exist");
  assert.ok(scratchVol.emptyDir, "scratch volume must be an emptyDir");
  const scratchMount = mounts.find((m) => m.name === "scratch");
  assert.ok(scratchMount, "scratch volumeMount must exist");
  assert.equal(scratchMount.mountPath, "/tmp", "scratch must be mounted at /tmp");

  // Invariant 6: Repo source volume exists and is mounted read-only
  const repoVol = volumes.find(
    (v) => v.name !== "thread-store" && v.name !== "scratch",
  );
  assert.ok(repoVol, "repo source volume must exist");
  const repoMount = mounts.find(
    (m) => m.name !== "thread-store" && m.name !== "scratch",
  );
  assert.ok(repoMount, "repo source volumeMount must exist");
  assert.equal(repoMount.name, repoVol.name, "repo mount name must match repo volume name");
  assert.equal(repoMount.readOnly, true, "repo source must be mounted read-only");
}

test("oracle: snapshot plus property checks on the rendered Job spec", () => {
  const rendered = renderJob(sampleLaunch, {
    name: "eval-t1-test",
    thread: "t1",
  });
  assert.deepEqual(rendered, SNAPSHOT, "rendered Job must match canonical snapshot byte for byte");
  assertJobProperties(rendered, "t1", "public");
});

test("property check: trusted launch enables IFD and builders flag in Job spec", () => {
  const builders = "ssh-ng://nix-remote-build@uplink x86_64-linux";
  const rendered = renderJob(trustedLaunch, {
    name: "eval-t2-trusted",
    thread: "t2",
    builders,
  });
  assertJobProperties(rendered, "t2", "trusted");
  const args = rendered.spec.template.spec.containers[0].args ?? [];
  const ifdIdx = args.indexOf("allow-import-from-derivation");
  assert.equal(args[ifdIdx + 1], "true");
  const buildersIdx = args.indexOf("builders");
  assert.equal(args[buildersIdx + 1], builders);
});

test("mutant: dropping runtimeClassName fails property check and snapshot", () => {
  const mutantJob = renderJob(sampleLaunch, {
    name: "eval-t1-test",
    thread: "t1",
    runtimeClassName: null,
  });
  assert.notDeepEqual(mutantJob, SNAPSHOT, "mutant Job without runtimeClassName must differ from snapshot");
  assert.throws(
    () => assertJobProperties(mutantJob, "t1", "public"),
    /runtimeClassName must be gvisor/,
    "property check must fail RED when runtimeClassName is dropped",
  );
});

test("mutant: PVC mounted at /nix/store fails property check", () => {
  const mutantJob = renderJob(sampleLaunch, {
    name: "eval-t1-test",
    thread: "t1",
    storeMountPath: "/nix/store",
  });
  assert.throws(
    () => assertJobProperties(mutantJob, "t1", "public"),
    /must not mount volume at \/nix\/store/,
    "property check must fail RED when PVC is mounted at /nix/store",
  );
});

test("mutant: argv missing --store fails property check", () => {
  const job = renderJob(sampleLaunch, {
    name: "eval-t1-test",
    thread: "t1",
  });
  const storeIdx = job.spec.template.spec.containers[0].args?.indexOf("--store") ?? -1;
  assert.ok(storeIdx >= 0);
  const mutantJob: K8sJob = {
    ...job,
    spec: {
      ...job.spec,
      template: {
        ...job.spec.template,
        spec: {
          ...job.spec.template.spec,
          containers: [
            {
              ...job.spec.template.spec.containers[0],
              args: job.spec.template.spec.containers[0].args?.filter(
                (_, i) => i !== storeIdx && i !== storeIdx + 1,
              ),
            },
          ],
        },
      },
    },
  };
  assert.throws(
    () => assertJobProperties(mutantJob, "t1", "public"),
    /argv must carry --store/,
    "property check must fail RED when argv is missing --store",
  );
});

test("oracle 22: untrusted Job mount set has exactly repo source (read-only), thread store, scratch emptyDir, and no Secret", () => {
  const repoVol = repoSourceVolume("repo-source-t1");
  const repoMount = repoSourceMount("/src");
  const job = renderJob(sampleLaunch, {
    name: "eval-t1-untrusted",
    thread: "t1",
    extraVolumes: [repoVol],
    extraVolumeMounts: [repoMount],
  });
  assertUntrustedJobMounts(job);
  assertJobProperties(job, "t1", "public");
});

test("mutant (oracle 22): adding thread-state volume fails property check", () => {
  const repoVol = repoSourceVolume("repo-source-t1");
  const repoMount = repoSourceMount("/src");
  const mutantJob = renderJob(sampleLaunch, {
    name: "eval-t1-untrusted",
    thread: "t1",
    extraVolumes: [
      repoVol,
      {
        name: "thread-state",
        persistentVolumeClaim: { claimName: "thread-state-t1" },
      },
    ],
    extraVolumeMounts: [
      repoMount,
      {
        name: "thread-state",
        mountPath: "/state",
      },
    ],
  });
  assert.throws(
    () => assertUntrustedJobMounts(mutantJob),
    /thread-state volume must never mount/,
    "property check must fail RED when thread-state volume is mounted",
  );
  assert.throws(
    () => assertJobProperties(mutantJob, "t1", "public"),
    /thread-state volume must never mount/,
    "assertJobProperties must fail RED when thread-state volume is mounted",
  );
});

test("mutant (oracle 22): mounting Secret on untrusted Job fails property check", () => {
  const repoVol = repoSourceVolume("repo-source-t1");
  const repoMount = repoSourceMount("/src");
  const mutantJob = renderJob(sampleLaunch, {
    name: "eval-t1-untrusted",
    thread: "t1",
    extraVolumes: [
      repoVol,
      {
        name: "builder-key",
        secret: { secretName: "builder-key" },
      },
    ],
    extraVolumeMounts: [
      repoMount,
      {
        name: "builder-key",
        mountPath: "/root/.ssh",
      },
    ],
  });
  assert.throws(
    () => assertUntrustedJobMounts(mutantJob),
    /untrusted Job must not mount any Secret/,
    "property check must fail RED when Secret is mounted on untrusted Job",
  );
  assert.throws(
    () => assertJobProperties(mutantJob, "t1", "public"),
    /untrusted Job must not mount any Secret/,
    "assertJobProperties must fail RED when Secret is mounted on untrusted Job",
  );
});

test("mutant (oracle 22): repo source mounted read-write fails property check", () => {
  const repoVol = repoSourceVolume("repo-source-t1");
  const mutantJob = renderJob(sampleLaunch, {
    name: "eval-t1-untrusted",
    thread: "t1",
    extraVolumes: [repoVol],
    extraVolumeMounts: [
      {
        name: "repo",
        mountPath: "/src",
        readOnly: false,
      },
    ],
  });
  assert.throws(
    () => assertUntrustedJobMounts(mutantJob),
    /repo source must be mounted read-only/,
    "property check must fail RED when repo source is mounted read-write",
  );
});

test("mutant (oracle 22): missing repo source volume fails property check", () => {
  const mutantJob = renderJob(sampleLaunch, {
    name: "eval-t1-untrusted",
    thread: "t1",
  });
  assert.throws(
    () => assertUntrustedJobMounts(mutantJob),
    /untrusted Job must have exactly 3 volumes/,
    "property check must fail RED when repo source volume is missing",
  );
});

test("mutant (oracle 22): unexpected fourth volume fails property check", () => {
  const repoVol = repoSourceVolume("repo-source-t1");
  const repoMount = repoSourceMount("/src");
  const mutantJob = renderJob(sampleLaunch, {
    name: "eval-t1-untrusted",
    thread: "t1",
    extraVolumes: [
      repoVol,
      {
        name: "extra-cache",
        emptyDir: {},
      },
    ],
    extraVolumeMounts: [
      repoMount,
      {
        name: "extra-cache",
        mountPath: "/cache",
      },
    ],
  });
  assert.throws(
    () => assertUntrustedJobMounts(mutantJob),
    /untrusted Job must have exactly 3 volumes/,
    "property check must fail RED when unapproved extra volume is present",
  );
});

// Helper for stubbing the Kubernetes API over HTTP.
function startStubK8sServer(handlers: {
  createJob?: (job: K8sJob) => { status: number; body: unknown };
  getJob?: (name: string) => { status: number; body: unknown };
  deleteJob?: (name: string) => { status: number; body: unknown };
  getPods?: (selector: string) => { status: number; body: unknown };
  getPodLog?: (podName: string) => { status: number; body: string };
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";
    const path = url.pathname;

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // POST jobs
      if (method === "POST" && path.match(/^\/apis\/batch\/v1\/namespaces\/[^/]+\/jobs$/)) {
        const job = JSON.parse(body || "{}") as K8sJob;
        const result = handlers.createJob?.(job) ?? { status: 201, body: job };
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }
      // GET job
      const jobMatch = path.match(/^\/apis\/batch\/v1\/namespaces\/[^/]+\/jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        const name = decodeURIComponent(jobMatch[1]);
        const result = handlers.getJob?.(name) ?? {
          status: 200,
          body: {
            metadata: { name },
            status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] },
          },
        };
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }
      // DELETE job
      if (method === "DELETE" && jobMatch) {
        const name = decodeURIComponent(jobMatch[1]);
        const result = handlers.deleteJob?.(name) ?? { status: 200, body: {} };
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }
      // GET pods
      if (method === "GET" && path.match(/^\/api\/v1\/namespaces\/[^/]+\/pods$/)) {
        const selector = url.searchParams.get("labelSelector") ?? "";
        const result = handlers.getPods?.(selector) ?? {
          status: 200,
          body: {
            items: [
              {
                metadata: { name: "eval-pod-1" },
                status: {
                  phase: "Succeeded",
                  containerStatuses: [
                    {
                      name: "eval",
                      state: { terminated: { exitCode: 0, reason: "Completed" } },
                    },
                  ],
                },
              },
            ],
          },
        };
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
        return;
      }
      // GET pod log
      const logMatch = path.match(/^\/api\/v1\/namespaces\/[^/]+\/pods\/([^/]+)\/log$/);
      if (method === "GET" && logMatch) {
        const podName = decodeURIComponent(logMatch[1]);
        const result = handlers.getPodLog?.(podName) ?? { status: 200, body: "42\n" };
        res.writeHead(result.status, { "content-type": "text/plain" });
        res.end(result.body);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", path }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test("submit and watch: successful eval completes with exit 0 and limit_hit none", async () => {
  const createdJobs: string[] = [];
  const deletedJobs: string[] = [];

  const server = await startStubK8sServer({
    createJob: (job) => {
      createdJobs.push(job.metadata.name);
      return { status: 201, body: job };
    },
    deleteJob: (name) => {
      deletedJobs.push(name);
      return { status: 200, body: {} };
    },
    getPodLog: () => ({ status: 200, body: '"hello"\n' }),
  });
  after(server.close);

  const client = new K8sClient({ baseUrl: server.url, namespace: "genie-eval" });
  const result = await runK8sEval(sampleLaunch, {
    client,
    name: "job-success-test",
    thread: "t-succ",
  });

  assert.equal(result.exit, 0);
  assert.equal(result.stdout_tail.trim(), '"hello"');
  assert.equal(result.limit_hit, "none");
  assert.ok(createdJobs.includes("job-success-test"));
  assert.ok(deletedJobs.includes("job-success-test"));
});

test("submit and watch: active deadline exceeded results in timeout limit_hit", async () => {
  const server = await startStubK8sServer({
    getJob: (name) => ({
      status: 200,
      body: {
        metadata: { name },
        status: {
          failed: 1,
          conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }],
        },
      },
    }),
    getPods: () => ({
      status: 200,
      body: {
        items: [
          {
            metadata: { name: "eval-timeout-pod" },
            status: {
              containerStatuses: [
                {
                  name: "eval",
                  state: { terminated: { exitCode: 137, reason: "DeadlineExceeded" } },
                },
              ],
            },
          },
        ],
      },
    }),
  });
  after(server.close);

  const client = new K8sClient({ baseUrl: server.url });
  const result = await runK8sEval(sampleLaunch, { client, name: "job-timeout" });
  assert.equal(result.exit, 124);
  assert.equal(result.limit_hit, "timeout");
});

test("submit and watch: container OOMKilled results in oom limit_hit", async () => {
  const server = await startStubK8sServer({
    getJob: (name) => ({
      status: 200,
      body: {
        metadata: { name },
        status: {
          failed: 1,
          conditions: [{ type: "Failed", status: "True" }],
        },
      },
    }),
    getPods: () => ({
      status: 200,
      body: {
        items: [
          {
            metadata: { name: "eval-oom-pod" },
            status: {
              containerStatuses: [
                {
                  name: "eval",
                  state: { terminated: { exitCode: 137, reason: "OOMKilled" } },
                },
              ],
            },
          },
        ],
      },
    }),
  });
  after(server.close);

  const client = new K8sClient({ baseUrl: server.url });
  const result = await runK8sEval(sampleLaunch, { client, name: "job-oom" });
  assert.equal(result.exit, 137);
  assert.equal(result.limit_hit, "oom");
});

test("submit and watch: network fetch failure in pod logs results in egress limit_hit", async () => {
  const server = await startStubK8sServer({
    getJob: (name) => ({
      status: 200,
      body: {
        metadata: { name },
        status: { failed: 1, conditions: [{ type: "Failed", status: "True" }] },
      },
    }),
    getPods: () => ({
      status: 200,
      body: {
        items: [
          {
            metadata: { name: "eval-egress-pod" },
            status: {
              containerStatuses: [
                {
                  name: "eval",
                  state: { terminated: { exitCode: 1, reason: "Error" } },
                },
              ],
            },
          },
        ],
      },
    }),
    getPodLog: () => ({
      status: 200,
      body: "error: unable to download 'https://github.com/owner/repo/archive.tar.gz': Could not resolve host: github.com (6)",
    }),
  });
  after(server.close);

  const client = new K8sClient({ baseUrl: server.url });
  const result = await runK8sEval(sampleLaunch, { client, name: "job-egress" });
  assert.equal(result.exit, 1);
  assert.equal(result.limit_hit, "egress");
});

test("submit and watch: foreign SIGKILL results in unknown limit_hit", async () => {
  const server = await startStubK8sServer({
    getJob: (name) => ({
      status: 200,
      body: {
        metadata: { name },
        status: { failed: 1, conditions: [{ type: "Failed", status: "True" }] },
      },
    }),
    getPods: () => ({
      status: 200,
      body: {
        items: [
          {
            metadata: { name: "eval-sigkill-pod" },
            status: {
              containerStatuses: [
                {
                  name: "eval",
                  state: { terminated: { exitCode: 137, reason: "Error" } },
                },
              ],
            },
          },
        ],
      },
    }),
    getPodLog: () => ({ status: 200, body: "terminated by external SIGKILL" }),
  });
  after(server.close);

  const client = new K8sClient({ baseUrl: server.url });
  const result = await runK8sEval(sampleLaunch, { client, name: "job-unknown" });
  assert.equal(result.exit, 137);
  assert.equal(result.limit_hit, "unknown");
});

test("k8sRunner satisfies Runner interface and works with perThread lock", async () => {
  const server = await startStubK8sServer({
    getPodLog: () => ({ status: 200, body: '"locked"\n' }),
  });
  after(server.close);

  const client = new K8sClient({ baseUrl: server.url });
  const runner = k8sRunner({ client, thread: "thread-lock-test" });
  const lockedRunner = perThread(runner);

  const res1 = await lockedRunner("thread-lock-test", sampleLaunch);
  const res2 = await lockedRunner("thread-lock-test", sampleLaunch);

  assert.equal(res1.exit, 0);
  assert.equal(res2.exit, 0);
  assert.equal(res1.limit_hit, "none");
  assert.equal(res2.limit_hit, "none");
});
