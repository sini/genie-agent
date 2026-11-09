import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { perThread } from "../src/eval/lock.ts";
import { withCache } from "../src/eval/cache.ts";
import {
  K8sClient,
  k8sRunner,
  renderJob,
  runK8sEval,
  formatBuilderEntry,
  type K8sJob,
  type RenderJobOptions,
} from "../src/eval/k8s.ts";
import { effectiveTier, type Launch } from "../src/eval/run.ts";

const options: RenderJobOptions = {
  namespace: "custom-evaluation",
  image: "registry.example/evaluator:fixed",
  storeClaimName: "caller-store",
  repoClaimName: "caller-source",
  storeSubPath: "stores",
  repoSubPath: "sources",
  memoryMax: 524288000,
  cpu: "750m",
  timeoutMs: 27501,
  scratchLimit: "300Mi",
};
const launch: Launch = {
  thread: "!Thread_ID:example.org",
  sender_tier: "public",
  request: {
    repo: "owner/repository",
    rev: "fixed",
    attr: "package",
    trusted: "no",
  },
};
const args = (job: K8sJob) => job.spec.template.spec.containers[0].args!;
const mounts = (job: K8sJob) =>
  job.spec.template.spec.containers[0].volumeMounts!;
const volumes = (job: K8sJob) => job.spec.template.spec.volumes!;

test("eval Job explicitly disables ambient Kubernetes service-account credentials", () => {
  for (const tier of ["public", "trusted"] as const) {
    const job = renderJob({ ...launch, sender_tier: tier, request: { ...launch.request, trusted: "yes" } }, options);
    assert.equal(job.spec.template.spec.automountServiceAccountToken, false, "eval must not receive ambient API credentials");
  }
});

test("Kubernetes cleanup forwards its own bounded abort signal", async () => {
  const client = new K8sClient({ baseUrl: "https://fixture.invalid", namespace: "cleanup", fetch: async (_url, init) => {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(done, 200);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cleanup aborted")); }, { once: true });
    });
    return new Response("{}", { status: 200 });
  } });
  const deletion = client.deleteJob("fixture", undefined, AbortSignal.timeout(20)).then(() => "completed", () => "aborted");
  const result = await Promise.race([deletion, new Promise<string>((done) => setTimeout(() => done("not-aborted"), 100))]);
  assert.equal(result, "aborted", "cleanup must use its independent deadline");
});
const optionValue = (job: K8sJob, name: string) =>
  args(job)[args(job).indexOf(name) + 1];
const worktrees = mkdtempSync(`${tmpdir()}/genie-k8s-source-`);
after(() => rmSync(worktrees, { recursive: true, force: true }));
mkdirSync(`${worktrees}/${launch.thread}/checkout/nested`, { recursive: true });
writeFileSync(`${worktrees}/${launch.thread}/checkout/flake.nix`, "{}\n");
writeFileSync(
  `${worktrees}/${launch.thread}/checkout/nested/flake.nix`,
  "{}\n",
);
symlinkSync("checkout/nested", `${worktrees}/${launch.thread}/alias`);
const local: Launch = {
  ...launch,
  request: { worktreeSubdir: "checkout", attr: "package", trusted: "no" },
};

function properties(job: K8sJob) {
  const container = job.spec.template.spec.containers[0];
  assert.equal(job.metadata.namespace, options.namespace);
  assert.equal(container.image, options.image);
  assert.equal(job.spec.template.spec.runtimeClassName, undefined);
  assert.equal(job.spec.activeDeadlineSeconds, 28);
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.template.spec.restartPolicy, "Never");
  assert.deepEqual(container.resources, {
    requests: { cpu: "750m", memory: "524288000" },
    limits: { cpu: "750m", memory: "524288000" },
  });
  assert.equal(optionValue(job, "max-jobs"), "0");
  assert.equal(optionValue(job, "pure-eval"), "true");
  assert.equal(optionValue(job, "substituters"), "");
  assert.equal(optionValue(job, "accept-flake-config"), "false");
  assert.equal(
    mounts(job).find((m) => m.name === "thread-store")?.subPath,
    `stores/${launch.thread}`,
  );
  assert.ok(!volumes(job).some((v) => v.name === "thread-state"));
  assert.ok(!mounts(job).some((m) => m.mountPath === "/nix/store"));
}

test("oracle: snapshot plus property checks on the rendered Job spec", () => {
  const job = renderJob(launch, { ...options, name: "configured-evaluation" });
  properties(job);
  assert.deepEqual(job.metadata, {
    name: "configured-evaluation",
    namespace: options.namespace,
    labels: {
      "app.kubernetes.io/name": "genie-eval",
      "app.kubernetes.io/component": "eval",
      "genie.agent/thread": "thread-id-example-org",
      "genie.agent/tier": "public",
    },
  });
  assert.deepEqual(volumes(job), [
    {
      name: "thread-store",
      persistentVolumeClaim: { claimName: "caller-store" },
    },
    { name: "scratch", emptyDir: { sizeLimit: "300Mi" } },
  ]);
  assert.ok(args(job).includes("github:owner/repository/fixed#package"));
  assert.equal(optionValue(job, "builders"), "");
});

test("generic Job requires caller namespace image store and API, with no fleet defaults", async () => {
  for (const key of ["namespace", "image", "storeClaimName"] as const) {
    assert.throws(
      () => renderJob(launch, { ...options, [key]: undefined } as any),
      new RegExp(key),
    );
  }
  await assert.rejects(runK8sEval(launch, options), /Kubernetes API/);
  const job = renderJob(launch, {
    ...options,
    runtimeClassName: "caller-runtime",
  });
  assert.equal(job.spec.template.spec.runtimeClassName, "caller-runtime");
  assert.ok(
    !JSON.stringify(renderJob(launch, options)).match(
      /ghcr\.io\/sini|gvisor|genie-eval:latest/,
    ),
  );
});

test("oracle GX1 (F6): captured thread selects confined source and store while labels are sanitised", () => {
  const job = renderJob(local, {
    ...options,
    worktreeRoot: worktrees,
    thread: "forged",
  } as any);
  properties(job);
  const source = mounts(job).find((m) => m.name === "repo");
  assert.deepEqual(source, {
    name: "repo",
    mountPath: "/src",
    readOnly: true,
    subPath: `sources/${launch.thread}/checkout`,
  });
  assert.deepEqual(
    volumes(job).find((v) => v.name === "repo"),
    {
      name: "repo",
      persistentVolumeClaim: { claimName: "caller-source", readOnly: true },
    },
  );
  assert.ok(args(job).includes("path:/src#package"));
  assert.equal(
    job.metadata.labels?.["genie.agent/thread"],
    "thread-id-example-org",
  );
  assert.equal(
    job.spec.template.metadata?.labels?.["genie.agent/thread"],
    "thread-id-example-org",
  );
  const alias = renderJob(
    { ...local, request: { ...local.request, worktreeSubdir: "alias" } },
    { ...options, worktreeRoot: worktrees, repoMountPath: "/selected-source" },
  );
  assert.equal(
    mounts(alias).find((m) => m.name === "repo")?.subPath,
    `sources/${launch.thread}/checkout/nested`,
  );
  assert.ok(args(alias).includes("path:/selected-source#package"));
});

test("coordinate requests never mount a local source and preserve their coordinate", () => {
  const job = renderJob(launch, { ...options, repoClaimName: undefined });
  assert.ok(!volumes(job).some((v) => v.name === "repo"));
  assert.ok(!mounts(job).some((m) => m.name === "repo"));
  assert.ok(args(job).includes("github:owner/repository/fixed#package"));
});

test("source validation refuses traversal, outside symlinks and missing thread before submission", () => {
  for (const thread of [
    undefined,
    "../other",
    "a/b",
    "has space",
    ".",
    "..",
    "a\\b",
  ]) {
    assert.throws(() => renderJob({ ...launch, thread }, options), /thread/);
  }
  for (const key of ["repoSubPath", "storeSubPath"] as const) {
    for (const prefix of [
      "../outside",
      "/absolute",
      "foo/../other",
      "{thread}",
    ]) {
      assert.throws(
        () =>
          renderJob(local, {
            ...options,
            worktreeRoot: worktrees,
            [key]: prefix,
          }),
        /subPath/,
      );
    }
  }
  assert.throws(
    () =>
      renderJob(local, {
        ...options,
        worktreeRoot: worktrees,
        repoClaimName: undefined,
      }),
    /repoClaimName/,
  );
  assert.throws(() => renderJob(local, options), /worktreeRoot/);
  assert.throws(
    () =>
      renderJob(
        { ...local, request: { ...local.request, worktreeSubdir: "../other" } },
        { ...options, worktreeRoot: worktrees },
      ),
    /worktreeSubdir/,
  );
  symlinkSync(tmpdir(), `${worktrees}/${launch.thread}/escape`);
  assert.throws(
    () =>
      renderJob(
        { ...local, request: { ...local.request, worktreeSubdir: "escape" } },
        { ...options, worktreeRoot: worktrees },
      ),
    /escapes/,
  );
});

test("Job rejects mounts that shadow the evaluator and keeps authority labels fixed", () => {
  for (const key of [
    "repoMountPath",
    "storeMountPath",
    "scratchMountPath",
    "builderKeyMountPath",
  ] as const) {
    for (const value of [
      "/nix/store",
      "/nix/store/closure",
      "/",
      "relative",
      "/tmp/../nix",
    ]) {
      assert.throws(
        () => renderJob(launch, { ...options, [key]: value }),
        /MountPath/,
      );
    }
  }
  const job = renderJob(launch, {
    ...options,
    labels: { "genie.agent/thread": "forged", "genie.agent/tier": "trusted" },
  });
  assert.equal(
    job.metadata.labels?.["genie.agent/thread"],
    "thread-id-example-org",
  );
  assert.equal(job.metadata.labels?.["genie.agent/tier"], "public");
  assert.throws(
    () =>
      renderJob(launch, {
        ...options,
        env: [{ name: "HOME", value: "/root" }],
      }),
    /environment overrides/,
  );
});

test("Job validates request coordinates attr and apply with shared Nix argv semantics", () => {
  for (const request of [
    { ...launch.request, repo: "owner/repo/other" },
    { ...launch.request, rev: "main#other" },
    { ...launch.request, attr: "pkg;evil" },
    { ...launch.request, apply: "" },
    { ...launch.request, attr: "checks", apply: "x: x" },
    { ...local.request, repo: "owner/repo" },
  ]) {
    assert.throws(() => renderJob({ ...launch, request }, options));
  }
  const applied = renderJob(
    { ...launch, request: { ...launch.request, apply: "x: x.version" } },
    options,
  );
  assert.equal(optionValue(applied, "--apply"), "x: x.version");
  const checked = renderJob(
    { ...launch, request: { ...launch.request, attr: "checks" } },
    options,
  );
  assert.ok(args(checked).includes("--no-build"));
  const stubbed = renderJob(
    { ...launch, request: { ...launch.request, secrets: "stub" } },
    options,
  );
  assert.match(optionValue(stubbed, "--apply"), /placeholder-secret/);
});

test("Job budgets translate milliseconds and bytes and reject invalid values", () => {
  for (const key of ["timeoutMs", "memoryMax"] as const) {
    for (const value of [0, -1, Infinity, NaN])
      assert.throws(
        () => renderJob(launch, { ...options, [key]: value }),
        new RegExp(key),
      );
  }
  const job = renderJob(launch, {
    ...options,
    timeoutMs: 120000,
    memoryMax: undefined,
    cpu: undefined,
  });
  assert.equal(job.spec.activeDeadlineSeconds, 120);
  assert.equal(job.spec.template.spec.containers[0].resources, undefined);
});

const builder = {
  uri: "ssh-ng://builder.example",
  system: "x86_64-linux",
  maxJobs: 3,
  supportedFeatures: ["feature"],
};
test("oracle 10: four-row truth table over (request, tier) gives (effective trust, builder key mounted) on k8sRunner submissions", async () => {
  const server = await api();
  const runner = k8sRunner({
    ...options,
    k8s: { baseUrl: server.url },
    builder,
    builderKeySecretName: "caller-builder",
    builderKeyMountPath: "/builder",
    builderKeyFileName: "key",
  });
  for (const tier of ["public", "trusted"] as const) {
    for (const trusted of ["yes", "no"] as const) {
      const current: Launch = {
        ...launch,
        sender_tier: tier,
        request: { ...launch.request, trusted },
      };
      assert.equal((await runner(current)).exit, 0);
      const job = server.jobs.at(-1)!;
      const allowed = effectiveTier(current) === "trusted";
      assert.equal(
        volumes(job).some((v) => v.secret),
        allowed,
      );
      assert.equal(
        optionValue(job, "allow-import-from-derivation"),
        allowed ? "true" : "false",
      );
      assert.equal(
        optionValue(job, "builders"),
        allowed ? formatBuilderEntry(builder, "/builder/key") : "",
      );
      if (allowed) {
        assert.deepEqual(
          volumes(job).find((v) => v.name === "builder-key")?.secret,
          { secretName: "caller-builder", defaultMode: 0o400 },
        );
        assert.equal(
          mounts(job).find((m) => m.name === "builder-key")?.readOnly,
          true,
        );
      }
    }
  }
});

test("trusted eval without configured builders mounts no builder credential", () => {
  const trusted: Launch = {
    ...launch,
    sender_tier: "trusted",
    request: { ...launch.request, trusted: "yes" },
  };
  const job = renderJob(trusted, options);
  assert.ok(!volumes(job).some((v) => v.secret));
  assert.ok(
    !job.spec.template.spec.containers[0].env?.some(
      (e) => e.name === "NIX_SSHOPTS",
    ),
  );
  assert.throws(
    () => renderJob(trusted, { ...options, builder }),
    /builderKeySecretName/,
  );
});

async function api(
  config: {
    exit?: number;
    reason?: string;
    deadline?: boolean;
    log?: string;
    failCreate?: boolean;
    watchFailure?: boolean;
    failLogs?: boolean;
    stallCreate?: boolean;
    noPods?: boolean;
    failPods?: boolean;
    delayMs?: number;
  } = {},
) {
  const jobs: K8sJob[] = [];
  const deleted: string[] = [];
  const headers: string[] = [];
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    headers.push(req.headers.authorization ?? "");
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", () => {
      const handle = () => {
        const reply = (value: unknown, status = 200) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (req.method === "POST") {
          if (config.stallCreate) {
            jobs.push(JSON.parse(body));
            return;
          }
          if (config.failCreate)
            return reply({ error: "upstream-private-token" }, 403);
          const job = JSON.parse(body);
          jobs.push(job);
          return reply(job, 201);
        }
        if (req.method === "DELETE") {
          deleted.push(req.url!);
          return reply({});
        }
        if (req.url?.includes("/pods?")) {
          if (config.failPods)
            return reply({ error: "upstream-private-token" }, 403);
          if (config.noPods) return reply({ items: [] });
          return reply({
            items: [
              {
                metadata: { name: "pod" },
                status: {
                  containerStatuses: [
                    {
                      name: "eval",
                      state: {
                        terminated: {
                          exitCode: config.exit ?? 0,
                          reason: config.reason ?? "Completed",
                        },
                      },
                    },
                  ],
                },
              },
            ],
          });
        }
        if (new URL(req.url!, "http://fixture").pathname.endsWith("/log")) {
          res.writeHead(config.failLogs ? 403 : 200);
          return res.end(config.log ?? "42\n");
        }
        if (config.watchFailure)
          return reply({ error: "upstream-private-token" }, 500);
        reply({
          status: config.deadline
            ? {
                failed: 1,
                conditions: [
                  {
                    type: "Failed",
                    status: "True",
                    reason: "DeadlineExceeded",
                  },
                ],
              }
            : { succeeded: 1 },
        });
      };
      if (config.delayMs) setTimeout(handle, config.delayMs);
      else handle();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    jobs,
    deleted,
    headers,
    paths,
  };
}

test("submit and watch: successful eval completes with exit 0 and limit_hit none", async () => {
  const server = await api({ log: "x".repeat(6000) + "tail" });
  const client = new K8sClient({
    baseUrl: server.url,
    namespace: options.namespace,
    token: "root-only-test-value",
  });
  const result = await runK8sEval(launch, { ...options, client });
  assert.equal(result.exit, 0);
  assert.equal(result.limit_hit, "none");
  assert.equal(result.stdout_tail.length, 4096);
  assert.ok(result.stdout_tail.endsWith("tail"));
  assert.equal(result.stderr_tail, "");
  assert.equal(server.deleted.length, 1);
  assert.ok(server.headers.every((v) => v === "Bearer root-only-test-value"));
  assert.ok(!JSON.stringify(server.jobs).includes("root-only-test-value"));
  assert.ok(
    server.paths.every((p) => p.includes(`/namespaces/${options.namespace}/`)),
  );
});
for (const cell of [
  {
    name: "active deadline exceeded",
    deadline: true,
    exit: 124,
    limit: "timeout",
  },
  { name: "container OOMKilled", reason: "OOMKilled", exit: 137, limit: "oom" },
  {
    name: "network fetch failure",
    log: "error: unable to download 'https://example.test': Could not resolve host (6)",
    exit: 1,
    limit: "egress",
  },
  { name: "foreign SIGKILL", reason: "Error", exit: 137, limit: "unknown" },
] as const) {
  test(`submit and watch: ${cell.name} classification and cleanup`, async () => {
    const server = await api(cell);
    const result = await runK8sEval(launch, {
      ...options,
      k8s: { baseUrl: server.url },
    });
    assert.equal(result.exit, cell.exit);
    assert.equal(result.limit_hit, cell.limit);
    assert.equal(server.deleted.length, 1);
  });
}

test("configured API errors are content-free and never fall back to a local runner", async () => {
  for (const config of [{ failCreate: true }, { watchFailure: true }]) {
    const server = await api(config);
    await assert.rejects(
      runK8sEval(launch, {
        ...options,
        k8s: { baseUrl: server.url, token: "root-only-test-value" },
      }),
      (err: Error) => {
        assert.match(err.message, /k8s/);
        assert.ok(!err.message.includes("upstream-private-token"));
        assert.ok(!err.message.includes("root-only-test-value"));
        return true;
      },
    );
    assert.equal(server.deleted.length, 1);
  }
});

test("k8sRunner satisfies Runner interface and works with perThread lock", async () => {
  const server = await api();
  const locked = perThread(
    k8sRunner({ ...options, k8s: { baseUrl: server.url } }),
  );
  assert.equal((await locked(launch.thread!, launch)).exit, 0);
  assert.equal((await locked(launch.thread!, launch)).exit, 0);
  assert.equal(server.jobs.length, 2);
});

test("configured API timeout aborts a stalled submission without fallback", {
  timeout: 3000,
}, async () => {
  const server = await api({ stallCreate: true });
  await assert.rejects(
    runK8sEval(launch, {
      ...options,
      timeoutMs: 100,
      k8s: { baseUrl: server.url },
    }),
    /k8s API request failed/,
  );
  assert.equal(server.jobs.length, 1);
  assert.equal(server.deleted.length, 1);
});

test("configured Runner submits only the captured thread's selected local source", async () => {
  const server = await api();
  const runner = k8sRunner({
    ...options,
    worktreeRoot: worktrees,
    builder,
    builderKeySecretName: "caller-builder",
    k8s: { baseUrl: server.url },
  });
  for (const tier of ["public", "trusted"] as const) {
    await runner({
      ...local,
      sender_tier: tier,
      request: { ...local.request, trusted: "yes" },
    });
    const job = server.jobs.at(-1)!;
    assert.equal(
      mounts(job).find((mount) => mount.name === "repo")?.subPath,
      `sources/${launch.thread}/checkout`,
    );
    assert.equal(
      mounts(job).find((mount) => mount.name === "repo")?.readOnly,
      true,
    );
    assert.equal(
      volumes(job).some((volume) => volume.secret !== undefined),
      tier === "trusted",
    );
  }
});

test("missing pod or log retrieval fails instead of caching a blank successful eval", async () => {
  for (const failure of [
    { failLogs: true },
    { noPods: true },
    { failPods: true },
  ]) {
    const server = await api(failure);
    let cached = 0;
    const run = withCache(
      {
        cacheGet: () => undefined,
        cachePut: () => {
          cached++;
        },
      },
      (_, request) =>
        runK8sEval(request, { ...options, k8s: { baseUrl: server.url } }),
    );
    await assert.rejects(run(launch.thread!, launch), /k8s/);
    assert.equal(
      cached,
      0,
      "missing logs cannot become a cached successful eval",
    );
    assert.equal(server.deleted.length, 1);
  }
});

test("all execution API calls share one timeout budget and cleanup gets a fresh signal", {
  timeout: 3000,
}, async () => {
  const server = await api({ delayMs: 80 });
  await assert.rejects(
    runK8sEval(launch, {
      ...options,
      timeoutMs: 100,
      k8s: { baseUrl: server.url },
    }),
    /k8s/,
  );
  assert.equal(
    server.deleted.length,
    1,
    "fresh cleanup signal still deletes the created Job",
  );
});

test("pod logs request a byte limit and stream a bounded UTF-8 tail even when the server ignores it", async () => {
  const requested: string[] = [];
  let textCalled = false;
  let maxDecodedBytes = 0;
  const Decoder = globalThis.TextDecoder;
  class InspectDecoder extends Decoder {
    decode(input?: AllowSharedBufferSource, opts?: TextDecodeOptions) {
      if (input) maxDecodedBytes = Math.max(maxDecodedBytes, input.byteLength);
      return super.decode(input, opts);
    }
  }
  globalThis.TextDecoder = InspectDecoder;
  try {
    const suffix = new TextEncoder().encode("🔒".repeat(3000));
    let block = 0;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (block++ < 32) {
          controller.enqueue(new Uint8Array(1024 * 1024).fill(120));
          return;
        }
        if (offset < suffix.length) {
          controller.enqueue(suffix.subarray(offset, (offset += 3)));
          return;
        }
        controller.close();
      },
    });
    const response = new Response(body);
    response.text = async () => {
      textCalled = true;
      throw new Error("whole body retention is forbidden");
    };
    const client = new K8sClient({
      baseUrl: "https://api.example",
      namespace: options.namespace,
      fetch: async (url) => {
        requested.push(String(url));
        return response;
      },
    });
    const tail = await client.getPodLogs("pod");
    assert.equal(textCalled, false);
    assert.ok(new URL(requested[0]).searchParams.has("limitBytes"));
    assert.equal(tail, "🔒".repeat(2048));
    assert.ok(
      maxDecodedBytes <= 16384,
      `decode retained a whole chunk: ${maxDecodedBytes}`,
    );
  } finally {
    globalThis.TextDecoder = Decoder;
  }
});

test("HTTP log server may ignore limitBytes without forcing whole-body retention", async () => {
  let requested = "";
  const block = new Uint8Array(1024 * 1024).fill(120);
  const server = createServer((req, res) => {
    requested = req.url!;
    let remaining = 32;
    const pump = () => {
      while (remaining-- > 0) {
        if (!res.write(block)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end("🔒".repeat(3000));
    };
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const client = new K8sClient({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    namespace: options.namespace,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      response.text = async () => {
        throw new Error("whole-body retention forbidden");
      };
      return response;
    },
  });
  assert.equal(await client.getPodLogs("pod"), "🔒".repeat(2048));
  assert.equal(
    new URL(requested, "http://fixture").searchParams.get("limitBytes"),
    "16384",
  );
});
