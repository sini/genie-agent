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
  runK8sEval,
  submitAndWatchJob,
  type K8sJob,
  type K8sPod,
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
                mountPath: "/nix/store",
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

  // 4. Thread store volume mounted as store root
  const volumes = job.spec.template.spec.volumes ?? [];
  const mounts = container.volumeMounts ?? [];
  const storeVol = volumes.find((v) => v.name === "thread-store");
  assert.ok(storeVol, "thread-store volume must exist");
  assert.equal(
    storeVol.persistentVolumeClaim?.claimName,
    `thread-store-${expectedThread}`,
    "thread-store PVC claimName must match thread",
  );
  const storeMount = mounts.find((m) => m.name === "thread-store");
  assert.ok(storeMount, "thread-store volumeMount must exist");
  assert.equal(storeMount.mountPath, "/nix/store", "thread-store must be mounted at /nix/store");

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

  // 7. Nix command options
  assert.deepEqual(container.command, ["nix"]);
  assert.ok(container.args?.includes("max-jobs"));
  assert.ok(container.args?.includes("pure-eval"));
  assert.ok(container.args?.includes("connect-timeout"));
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
