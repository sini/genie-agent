// The eval runner's gating oracle, against the local fixture flakes under tests/fixtures/eval/.
// Run with `node --test tests/eval.test.ts`; needs nix and bwrap on PATH.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { effectiveTier, resolveCaBundle, runEval, type EvalResult, type Tier } from "../src/eval/run.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/eval/${name}`, import.meta.url));
const run = (name: string, attr: string, trusted: "yes" | "no", sender_tier: Tier) =>
  runEval({ request: { repo: "local/fixture", rev: name, attr, trusted }, sender_tier }, {
    localFlake: fixture(name),
    timeoutMs: 60_000,
  });

test("a plain flake evaluates", async () => {
  const r = await run("plain", "hello", "no", "public");
  assert.equal(r.exit, 0, r.stderr_tail);
  assert.equal(r.stdout_tail.trim(), '"hi"');
  assert.equal(r.limit_hit, "none");
});

test("IFD is refused under public", async () => {
  const r = await run("ifd", "ifd", "no", "public");
  assert.notEqual(r.exit, 0);
  assert.match(r.stderr_tail, /allow-import-from-derivation/);
});

test("IFD is admitted under trusted", async () => {
  const r = await run("ifd", "ifd", "yes", "trusted");
  assert.equal(r.exit, 0, r.stderr_tail);
  assert.equal(r.stdout_tail.trim(), '[ "manifest.nix" ]');
});

test("request.trusted cannot raise a public tier", async () => {
  const r = await run("ifd", "ifd", "yes", "public");
  assert.notEqual(r.exit, 0);
  assert.match(r.stderr_tail, /allow-import-from-derivation/);
});

test("request.trusted=no lowers a trusted tier", async () => {
  const r = await run("ifd", "ifd", "no", "trusted");
  assert.notEqual(r.exit, 0);
});

// Each refusal in the wording of Nix and of Lix ("pure eval mode", a bare "assertion failed").
for (const [attr, refusal] of [
  ["env", /assertion\b.*failed/],
  ["file", /forbidden in pure eval(uation)? mode/],
] as const) {
  test(`impure ${attr} fails under pure-eval, trusted or not`, async () => {
    for (const [trusted, tier] of [
      ["no", "public"],
      ["yes", "trusted"],
    ] as const) {
      const r = await run("impure", attr, trusted, tier);
      assert.notEqual(r.exit, 0, `${tier}: ${r.stdout_tail}`);
      assert.match(r.stderr_tail, refusal);
    }
  });
}

test("<nixpkgs> fails under pure-eval", async () => {
  const r = await run("impure", "nixpath", "no", "public");
  assert.notEqual(r.exit, 0, r.stdout_tail);
  assert.match(r.stderr_tail, /<nixpkgs>.*pure eval(uation)? mode|was not found in the Nix search path/);
});

test("an indirect flake reference resolves through no registry", async () => {
  const r = await run("registry", "resolved", "no", "public");
  assert.notEqual(r.exit, 0, r.stdout_tail);
  assert.match(r.stderr_tail, /cannot find flake 'flake:nixpkgs' in the flake registries/);
});

// The jail's environment, written out here rather than read from the runner, so a widened runner
// cannot widen what this cell expects.
const ALLOWLIST = {
  HOME: "/work/home",
  XDG_CACHE_HOME: "/work/cache",
  NIX_PATH: "",
  NIX_CONF_DIR: "/work/conf",
  NIX_STORE_DIR: "/work/nix/store",
  NIX_STATE_DIR: "/work/nix/var",
  NIX_LOG_DIR: "/work/nix/log",
  NIX_SSL_CERT_FILE: resolveCaBundle(),
};

// Whether pid is a descendant of this test process, by its parent chain.
const descends = (pid: string): boolean => {
  for (let p = pid; Number(p) > 1; ) {
    p = readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" ")[1];
    if (Number(p) === process.pid) return true;
  }
  return false;
};

test("the jail environment is exactly the allowlist, carrying nothing of the thread", async () => {
  const marker = randomUUID();
  process.env.GENIE_THREAD_SECRET = marker;
  try {
    // getEnv is "" under pure-eval whatever the environment holds, so read it from /proc as well:
    // every descendant whose argv names the fixture attribute, nix and bwrap both, while it runs.
    const pending = run("plain", "busy", "no", "public");
    const envs = new Map<string, string[]>();
    let done = false;
    pending.finally(() => (done = true));
    while (!done) {
      for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
        try {
          if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("path:/src#busy") || !descends(pid)) continue;
          const exe = readlinkSync(`/proc/${pid}/exe`);
          envs.set(`${pid} ${exe}`, readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean));
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const r = await pending;
    assert.equal(r.exit, 0, r.stderr_tail);
    assert.ok([...envs.keys()].some((k) => k.endsWith("/bin/nix")), `nix never seen: ${[...envs.keys()]}`);
    for (const [proc, env] of envs) {
      // bwrap sets PWD to the jail's working directory.
      const vars = Object.fromEntries(env.filter((e) => !e.startsWith("PWD=")).map((e) => e.split(/=(.*)/s, 2)));
      assert.deepEqual(vars, ALLOWLIST, proc);
    }
    const s = await run("impure", "secret", "no", "public");
    assert.equal(s.exit, 0, s.stderr_tail);
    assert.ok(!s.stdout_tail.includes(marker), s.stdout_tail);
  } finally {
    delete process.env.GENIE_THREAD_SECRET;
  }
});

// Each limit triggered for real. The egress and oom cells run the runner in a child process under a
// narrower host: a network namespace with no interface, and a delegated systemd scope.
const child = (argv: string[], attr: string, ...rest: string[]): EvalResult & { memory_max?: string[] } => {
  const r = spawnSync(argv[0], [...argv.slice(1), "node", fixture("child.ts"), attr, ...rest], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("an eval past the runner's timeout is limit timeout", async () => {
  const r = await runEval({ request: { repo: "local/fixture", rev: "limits", attr: "spin", trusted: "no" }, sender_tier: "public" }, {
    localFlake: fixture("limits"),
    timeoutMs: 3_000,
  });
  assert.equal(r.exit, 124);
  assert.equal(r.limit_hit, "timeout");
});

test("a fetch the network refuses is limit egress", () => {
  const r = child(["unshare", "-cn"], "lib");
  assert.notEqual(r.exit, 0);
  assert.equal(r.limit_hit, "egress", r.stderr_tail);
});

// The cap is the eval's own cgroup's, set by the runner, so the OOM killer never has the runner to pick:
// a cap on the runner's cgroup as well let a second OOM kill it while the dead eval's memory was still
// charged. The scope's 2G is a backstop for a runner that sets no cap, never reached by a capped eval.
const scope = ["systemd-run", "--user", "--scope", "-q", "-p", "Delegate=yes", "-p", "MemoryMax=2G", "-p", "MemorySwapMax=0", "-p", "OOMPolicy=continue"];
const MEMORY_MAX = String(512 * 2 ** 20);
test("an OOM kill under a memory cap is limit oom", { skip: spawnSync(scope[0], [...scope.slice(1), "true"]).status !== 0 && "no systemd user scope" }, () => {
  const r = child(scope, "oom", fixture("limits"), MEMORY_MAX);
  assert.deepEqual(r.memory_max, [MEMORY_MAX]);
  assert.equal(r.exit, 137);
  assert.equal(r.limit_hit, "oom");
});

// A network that drops packets rather than refusing them, as a CNP does: a default route over a veth
// to an address nobody answers. Not lo alone: with no other interface up Nix decides it is offline:
// one attempt, and a 1 s connect timeout when none is set. The namespace is root-mapped to make the link, then mapped
// back, since bwrap refuses capabilities.
const veth = "ip link add v0 type veth peer name v1 && ip addr add 10.0.0.1/24 dev v0 && ip link set v1 up && ip link set v0 up && ip route add default via 10.0.0.2";
const drops = ["unshare", "-rn", "sh", "-c", `${veth} && g=$1 && shift && exec unshare -U --map-user="$0" --map-group="$g" "$@"`, String(process.getuid()), String(process.getgid())];
test("a fetch the network drops is limit egress before the runner's deadline", () => {
  const r = child(drops, "drop", fixture("limits"));
  assert.equal(r.limit_hit, "egress", r.stderr_tail);
  assert.match(r.stderr_tail, /Connection timed out after 5\d{3} milliseconds/);
});

const killed = (argv: string[], ...args: string[]): EvalResult => {
  const r = spawnSync(argv[0], [...argv.slice(1), "node", fixture("kill.ts"), fixture("limits"), ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("an eval SIGKILLed from outside with no OOM kill is limit unknown", () => {
  const r = killed(["env"]);
  assert.equal(r.exit, 137);
  assert.equal(r.limit_hit, "unknown");
});

// The runner's cgroup delegated to it, as under a systemd service with Delegate=yes: each eval gets a
// cgroup of its own, so the OOM kill of the eval beside it is not counted as this one's.
const delegated = ["systemd-run", "--user", "--scope", "-q", "-p", "Delegate=yes", "-p", "MemoryMax=1G", "-p", "MemorySwapMax=0", "-p", "OOMPolicy=continue"];
test("a concurrent eval's OOM kill is not this one's, in a delegated cgroup", { skip: spawnSync(delegated[0], [...delegated.slice(1), "true"]).status !== 0 && "no systemd user scope" }, () => {
  const r = killed(delegated, "oom");
  assert.equal(r.exit, 137);
  assert.equal(r.limit_hit, "unknown");
});

test("a non-github coordinate is refused before nix runs", async () => {
  await assert.rejects(
    runEval({ request: { repo: "a/b/c", rev: "main", attr: "x", trusted: "no" }, sender_tier: "public" }),
    /not a github coordinate/,
  );
});

test("the clamp: trusted only on request yes and a trusted sender tier", () => {
  const request = { repo: "a/b", rev: "main", attr: "x", trusted: "yes" } as const;
  assert.equal(effectiveTier({ request, sender_tier: "trusted" }), "trusted");
  assert.equal(effectiveTier({ request, sender_tier: "public" }), "public");
  assert.equal(effectiveTier({ request: { ...request, trusted: "no" }, sender_tier: "trusted" }), "public");
  assert.equal(effectiveTier({ request: { ...request, trusted: "no" }, sender_tier: "public" }), "public");
});

test("the resolved CA bundle is a real file, not a symlink into /etc/static", () => {
  const ca = resolveCaBundle();
  assert.equal(existsSync(ca), true, `CA bundle file ${ca} must exist`);
  const st = lstatSync(ca);
  assert.equal(st.isFile(), true, `CA bundle file ${ca} must be a regular file, not a symlink`);
  assert.equal(ca.startsWith("/etc/static"), false, `CA bundle file ${ca} must not point to unmounted /etc/static`);
});

test("a TLS fetch inside the jail succeeds with the resolved CA bundle", async () => {
  const r = await run("tls", "fetch", "no", "public");
  assert.equal(r.exit, 0, r.stderr_tail);
  assert.match(r.stdout_tail.trim(), /^"\/work\/nix\/store\/[a-z0-9]+-example\.com"$/);
  assert.equal(r.limit_hit, "none");
});
