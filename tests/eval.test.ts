// The eval runner's gating oracle, against the local fixture flakes under tests/fixtures/eval/.
// Run with `node --test tests/eval.test.ts`; needs nix and bwrap on PATH.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { effectiveTier, runEval, type Tier } from "../src/eval/run.ts";

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
  NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
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
});
