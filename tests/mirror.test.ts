// The mirror fetcher's gating oracle, against fixture repositories served by a throwaway
// `git daemon` on 127.0.0.1. Run with `node --test tests/mirror.test.ts`; needs git on PATH.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { git, MirrorRefused, mirrorKey, worktreeFor, type Runner } from "../src/mirror/index.ts";

const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-mirror-test-`);
const served = `${tmp}/served`;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const sh = (args: string[], cwd = tmp) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8" }).trim();

let daemon: ReturnType<typeof spawn>;
let base = "";

// A bare fixture repository at served/<name>.git with one commit, and a work clone to push from.
function fixture(name: string): string {
  sh(["init", "-q", "--bare", "-b", "main", `${served}/${name}.git`]);
  sh(["clone", "-q", `${served}/${name}.git`, `${tmp}/work-${name}`]);
  return commit(name);
}
function commit(name: string): string {
  const work = `${tmp}/work-${name}`;
  sh(["commit", "-q", "--allow-empty", "-m", "c"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);
  return sh(["rev-parse", "HEAD"], work);
}

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  mkdirSync(served);
  daemon = spawn("git", ["daemon", "--export-all", "--reuseaddr", "--listen=127.0.0.1", `--port=${port}`, `--base-path=${served}`, served], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  base = `git://127.0.0.1:${port}`;
  fixture("probe");
  // The daemon is up once it serves the probe fixture.
  for (let i = 0; ; i++) {
    try {
      sh(["ls-remote", `${base}/probe`]);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(() => {
  daemon.kill();
  rmSync(tmp, { recursive: true, force: true });
});

// A fresh mirror and worktree root, and a runner that records every git argv before running it.
function setup() {
  const root = mkdtempSync(`${tmp}/case-`);
  const cfg = { mirrorRoot: `${root}/mirrors`, worktreeRoot: `${root}/worktrees` };
  const calls: string[][] = [];
  const run: Runner = (args) => {
    calls.push(args);
    return git(args);
  };
  const clones = () => calls.filter((a) => a.includes("--mirror")).length;
  const mirrors = () => readdirSync(cfg.mirrorRoot).filter((d) => !d.startsWith("."));
  return { cfg, calls, run, clones, mirrors };
}
const head = (p: string) => sh(["rev-parse", "HEAD"], p);

test("oracle: two threads on one repo share one clone, each with its own worktree", async () => {
  const rev = fixture("shared");
  const { cfg, run, clones, mirrors } = setup();
  const a = await worktreeFor(cfg, `${base}/shared`, "thread-a", run);
  const b = await worktreeFor(cfg, `${base}/shared`, "thread-b", run);
  assert.equal(clones(), 1);
  assert.equal(mirrors().length, 1);
  assert.notEqual(a.path, b.path);
  assert.deepEqual([a.rev, b.rev, head(a.path), head(b.path)], [rev, rev, rev, rev]);
});

test("two spellings of one URL share one mirror", async () => {
  assert.equal(mirrorKey("https://github.com/a/b"), mirrorKey("https://github.com/a/b.git/"));
  assert.equal(mirrorKey("https://github.com/a/b"), mirrorKey("HTTPS://GitHub.com/a/b"));
  assert.notEqual(mirrorKey("https://github.com/a/b"), mirrorKey("https://github.com/a/c"));
  fixture("spelled");
  const { cfg, run, clones, mirrors } = setup();
  await worktreeFor(cfg, `${base}/spelled`, "t", run);
  await worktreeFor(cfg, `${base.toUpperCase()}/spelled.git/`, "t", run);
  assert.equal(clones(), 1);
  assert.equal(mirrors().length, 1);
});

test("a refused URL or thread starts no git process", async () => {
  const { cfg, calls } = setup();
  const run: Runner = (args) => {
    calls.push(args);
    return Promise.resolve("");
  };
  const refused: [string, string, RegExp][] = [
    ["file:///etc", "t", /only https/],
    ["ssh://x/y", "t", /only https/],
    ["https://u:p@h/r", "t", /credentials/],
    ["https://u@h/r", "t", /credentials/],
    ["--upload-pack=x", "t", /only https/],
    ["ext::sh -c touch% /tmp/x", "t", /only https/],
    ["/etc", "t", /only https/],
    ["https://h/r ", "t", /whitespace/],
    [`${base}/probe`, "../x", /thread/],
    [`${base}/probe`, "-x", /thread/],
  ];
  for (const [url, thread, reason] of refused) {
    await assert.rejects(worktreeFor(cfg, url, thread, run), (e: unknown) => {
      assert.ok(e instanceof MirrorRefused, `${url}: ${e}`);
      assert.match(e.reason, reason);
      return true;
    });
  }
  assert.deepEqual(calls, []);
});

test("two concurrent calls for one URL clone once", async () => {
  fixture("racing");
  const { cfg, run, clones, mirrors } = setup();
  const [a, b] = await Promise.all([
    worktreeFor(cfg, `${base}/racing`, "t1", run),
    worktreeFor(cfg, `${base}/racing`, "t2", run),
  ]);
  assert.equal(clones(), 1);
  assert.equal(mirrors().length, 1);
  assert.equal(a.rev, b.rev);
});

test("a second call fetches, and the same worktree advances to the new head", async () => {
  const first = fixture("moving");
  const { cfg, run, clones } = setup();
  const a = await worktreeFor(cfg, `${base}/moving`, "t", run);
  assert.equal(a.rev, first);
  const second = commit("moving");
  const b = await worktreeFor(cfg, `${base}/moving`, "t", run);
  assert.notEqual(second, first);
  assert.equal(b.path, a.path);
  assert.equal(b.rev, second);
  assert.equal(head(b.path), second);
  assert.equal(clones(), 1);
});
