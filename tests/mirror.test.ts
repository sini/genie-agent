// The mirror fetcher's gating oracle, against fixture repositories served by a throwaway
// `git daemon` on 127.0.0.1. Run with `node --test tests/mirror.test.ts`; needs git on PATH.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { after, before, test } from "node:test";
import { computeWorktreeDiff } from "../src/broker/index.ts";
import { renderJob } from "../src/eval/k8s.ts";
import { runEval } from "../src/eval/run.ts";
import { confine, confineWrite, tier1, type Host, type Pi, type ToolCall } from "../src/tier1/index.ts";
import {
  diskBytes,
  git,
  gitRead,
  MirrorOverCap,
  MirrorOverQuota,
  MirrorRefused,
  mirrorKey,
  readMirrorPin,
  removeWorktrees,
  sanitizeGitStderr,
  worktreeFor,
  type MirrorConfig,
  type Runner,
} from "../src/mirror/index.ts";
import { errors, load } from "../src/tier1/schema.ts";
import { Lifecycle } from "../src/lifecycle/index.ts";
import { parseMatrixForward } from "../src/root/io.ts";
import { ThreadStateStore } from "../src/state/index.ts";
import { Supervisor } from "../src/supervisor/index.ts";

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
function commit(name: string, blobBytes = 0): string {
  const work = `${tmp}/work-${name}`;
  if (blobBytes) {
    // Random, so the pack cannot compress it below its size.
    writeFileSync(`${work}/blob`, randomBytes(blobBytes));
    sh(["add", "blob"], work);
  }
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
  base = `https://127.0.0.1:${port}`;
  fixture("probe");
  // The daemon is up once it serves the probe fixture.
  for (let i = 0; ; i++) {
    try {
      sh(["ls-remote", `git://127.0.0.1:${port}/probe`]);
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
function setup(fetchCap?: number, quota?: number) {
  const root = mkdtempSync(`${tmp}/case-`);
  const cfg: MirrorConfig = { mirrorRoot: `${root}/mirrors`, worktreeRoot: `${root}/worktrees`, fetchCap, quota, exempt: ["127.0.0.1"] };
  const calls: string[][] = [];
  const run: Runner = (args, signal) => {
    calls.push(args);
    return git(
      ["-c", "protocol.git.allow=always", ...args.map((a) => a.replace(/^https:\/\/127\.0\.0\.1:/i, "git://127.0.0.1:"))],
      signal,
    );
  };
  const clones = () => calls.filter((a) => a.includes("--mirror")).length;
  const mirrors = () => readdirSync(cfg.mirrorRoot).filter((d) => !d.startsWith("."));
  return { cfg, calls, run, clones, mirrors };
}
const head = (p: string) => {
  // Under C1 (`ls-tree` + `cat-file --batch`), `<worktreeRoot>/<thread>/<key>` has no `.git` metadata;
  // read the pinned commit from `<mirrorRoot>/<key>/genie-pins/<thread>`.
  const parts = p.split("/");
  const key = parts.at(-1)!;
  const thread = parts.at(-2)!;
  const caseRoot = parts.slice(0, -3).join("/");
  const pin = readMirrorPin(`${caseRoot}/mirrors/${key}`, thread);
  if (pin) return pin.rev;
  return sh(["rev-parse", "HEAD"], p);
};

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

const MiB = 1024 ** 2;
const cap = 4 * MiB;
const big = 64 * MiB;

// A runner that records the bytes git left in the directory it wrote, measured once git has
// exited and before the fetcher removes it.
function landing(run: Runner) {
  const landed: number[] = [];
  const measured: Runner = (args, signal) => {
    const wrote = args[0] === "clone" ? dirname(args.at(-1)!) : args[0] === "-C" && args.includes("fetch") ? args[1] : "";
    return run(args, signal).finally(() => wrote && landed.push(diskBytes(wrote)));
  };
  return { landed, measured };
}

// Killed while git ran: had it run to the end, the whole 64 MiB blob would have landed.
function overCap(landed: number[]) {
  return (e: unknown) => {
    assert.ok(e instanceof MirrorOverCap, String(e));
    const peak = landed.at(-1)!;
    assert.ok(peak > cap && peak < big / 2, `${peak} bytes landed`);
    console.log(`# overshoot ${peak - cap} bytes landed past a ${cap}-byte cap`);
    return true;
  };
}

test("oracle: an over-cap clone is killed and leaves nothing, an under-cap one is mirrored", async () => {
  fixture("huge");
  commit("huge", big);
  const small = fixture("small");
  const { cfg, run, mirrors } = setup(cap);
  const { landed, measured } = landing(run);
  await assert.rejects(worktreeFor(cfg, `${base}/huge`, "t", measured), overCap(landed));
  assert.deepEqual(readdirSync(cfg.mirrorRoot), []);
  const { rev } = await worktreeFor(cfg, `${base}/small`, "t", run);
  assert.equal(rev, small);
  assert.deepEqual(mirrors(), [mirrorKey(`${base}/small`)]);
});

test("a fetch that takes an unpinned mirror past its cap removes the mirror", async () => {
  fixture("growing");
  const { cfg, run, mirrors } = setup(cap);
  const { landed, measured } = landing(run);
  await use(cfg, `${base}/growing`, measured);
  assert.equal(mirrors().length, 1);
  commit("growing", big);
  await assert.rejects(worktreeFor(cfg, `${base}/growing`, "t", measured), overCap(landed));
  assert.deepEqual(readdirSync(cfg.mirrorRoot), []);
});

// A mirror's refs, every file in it with its size, and those sizes' total. Sizes as written, not
// as allocated: ZFS reports a file's allocated blocks only seconds after a write, even past a sync.
const refs = (dir: string) => sh(["for-each-ref", "--format=%(refname) %(objectname)"], dir);
function state(dir: string) {
  const sized = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => [`${e.parentPath.slice(dir.length)}/${e.name}`, statSync(`${e.parentPath}/${e.name}`).size] as const);
  const files = sized.map(([f, n]) => `${f} ${n}`).sort();
  return { refs: refs(dir), files, bytes: sized.reduce((t, [, n]) => t + n, 0) };
}
const prunes = (calls: string[][]) => calls.filter((a) => a.includes("prune"));

test("oracle: a killed over-cap fetch into a pinned mirror leaves its refs and bytes as they were, and its worktree resolves", async () => {
  fixture("kept");
  commit("kept", 1024);
  sh(["push", "-q", "origin", "HEAD:side"], `${tmp}/work-kept`);
  const url = `${base}/kept`;
  const { cfg, run, calls, mirrors } = setup(cap);
  const live = await worktreeFor(cfg, url, "t", run);
  const dir = `${cfg.mirrorRoot}/${mirrorKey(url)}`;
  const before = state(dir);
  // Deleted upstream, so a fetch that pruned before its transfer would drop it from the mirror.
  sh(["push", "-q", "origin", ":side"], `${tmp}/work-kept`);
  commit("kept", big);
  let left: string[] = [];
  const watched: Runner = (args, signal) =>
    run(args, signal).finally(() => args.includes("fetch") && (left = state(dir).files.filter((f) => !before.files.includes(f))));
  const n = calls.length;
  await assert.rejects(worktreeFor(cfg, url, "t", watched), MirrorOverCap);
  assert.deepEqual(left.map((f) => f.replace(/tmp_pack_\S* \d+$/, "tmp_pack_")), ["/objects/pack/tmp_pack_"]);
  assert.deepEqual(state(dir), before);
  assert.deepEqual(prunes(calls.slice(n)), []);
  assert.deepEqual(mirrors(), [mirrorKey(url)]);
  assert.equal(head(live.path), live.rev);
  assert.equal(readFileSync(`${live.path}/blob`).length, 1024);
});

test("oracle: refs deleted upstream are pruned only after a successful fetch, and a failed prune leaves them", async () => {
  const side = fixture("pruned");
  const work = `${tmp}/work-pruned`;
  sh(["push", "-q", "origin", "HEAD:side"], work);
  const url = `${base}/pruned`;
  const { cfg, run, calls } = setup(cap);
  await worktreeFor(cfg, url, "t", run);
  const dir = `${cfg.mirrorRoot}/${mirrorKey(url)}`;
  sh(["push", "-q", "origin", ":side"], work);
  const next = commit("pruned");
  // The prune step finds the repository gone, as when the remote drops between the two round-trips.
  const failing: Runner = (args, signal) => {
    if (!args.includes("prune")) return run(args, signal);
    renameSync(`${served}/pruned.git`, `${served}/pruned-gone.git`);
    return run(args, signal).finally(() => renameSync(`${served}/pruned-gone.git`, `${served}/pruned.git`));
  };
  await assert.rejects(worktreeFor(cfg, url, "t", failing), /remote prune/);
  assert.equal(refs(dir), `refs/heads/main ${next}\nrefs/heads/side ${side}`);
  const n = calls.length;
  await worktreeFor(cfg, url, "t", run);
  assert.equal(refs(dir), `refs/heads/main ${next}`);
  assert.deepEqual(
    calls.slice(n, n + 2).map((a) => a.find((x) => x === "fetch" || x === "prune")),
    ["fetch", "prune"],
  );
});

test("oracle: a pinned mirror already past its cap is refused before git starts", async () => {
  fixture("over");
  commit("over", 1024);
  const url = `${base}/over`;
  const { cfg, run, calls, mirrors } = setup(cap);
  const live = await worktreeFor(cfg, url, "t", run);
  cfg.fetchCap = 1024;
  const n = calls.length;
  await assert.rejects(worktreeFor(cfg, url, "t", run), MirrorOverCap);
  assert.deepEqual(calls.slice(n), []);
  assert.deepEqual(mirrors(), [mirrorKey(url)]);
  assert.equal(head(live.path), live.rev);
});

// Three fixture repositories of one 1 MiB blob each, and a quota that holds two of their mirrors
// but not three.
const quota = 2.5 * MiB;
function three(name: string): string[] {
  return ["a", "b", "c"].map((x) => {
    fixture(`${name}-${x}`);
    commit(`${name}-${x}`, MiB);
    return `${base}/${name}-${x}`;
  });
}
// A thread's clone of url whose worktree is then removed, as a finished thread's is.
async function use(cfg: MirrorConfig, url: string, run: Runner, fetch = worktreeFor) {
  const { path } = await fetch(cfg, url, "t", run);
  rmSync(path, { recursive: true, force: true });
}
const keys = (urls: string[]) => urls.map(mirrorKey).sort();

test("oracle: filling past the quota evicts the least-recently-used mirror and keeps the total under quota", async () => {
  const [a, b, c] = three("lru");
  const { cfg, run, mirrors } = setup(undefined, quota);
  await use(cfg, a, run);
  await use(cfg, b, run);
  await use(cfg, a, run);
  assert.deepEqual(mirrors().sort(), keys([a, b]));
  await use(cfg, c, run);
  assert.deepEqual(mirrors().sort(), keys([a, c]));
  assert.ok(diskBytes(cfg.mirrorRoot) <= quota, `${diskBytes(cfg.mirrorRoot)} bytes`);
});

test("oracle: a mirror with a live worktree is never evicted, even when it is the least recently used", async () => {
  const [a, b, c] = three("pinned");
  const { cfg, run, mirrors } = setup(undefined, quota);
  const live = await worktreeFor(cfg, a, "t", run);
  await use(cfg, b, run);
  await use(cfg, c, run);
  assert.deepEqual(mirrors().sort(), keys([a, c]));
  assert.equal(head(live.path), live.rev);
  assert.ok(diskBytes(cfg.mirrorRoot) <= quota, `${diskBytes(cfg.mirrorRoot)} bytes`);
});

test("oracle: when pinned mirrors alone pass the quota, the new fetch is refused and leaves no mirror", async () => {
  const [a, b, c] = three("full");
  const { cfg, run, mirrors } = setup(undefined, quota);
  await worktreeFor(cfg, a, "t", run);
  await worktreeFor(cfg, b, "t", run);
  await assert.rejects(worktreeFor(cfg, c, "t", run), (e: unknown) => {
    assert.ok(e instanceof MirrorOverQuota, String(e));
    assert.match(e.reason, /live worktrees/);
    return true;
  });
  assert.deepEqual(mirrors().sort(), keys([a, b]));
});

test("oracle: the least-recently-used order survives a restart of the fetcher", async () => {
  const [a, b, c] = three("restart");
  // A fresh module instance over the same mirror root, as after a restart.
  const restarted = (await import("../src/mirror/index.ts?restart")).worktreeFor as typeof worktreeFor;
  // The same mirrors made in the same order, with opposite recency: whatever orders them other
  // than their recorded use picks the wrong one in one of the two roots.
  for (const [order, kept] of [
    [[a, b], [b, c]],
    [[a, b, a], [a, c]],
  ]) {
    const { cfg, run, mirrors } = setup(undefined, quota);
    for (const url of order) await use(cfg, url, run);
    await use(cfg, c, run, restarted);
    assert.deepEqual(mirrors().sort(), keys(kept), `after ${order.length} uses`);
  }
});

test("oracle: diskBytes counts apparent file sizes, whether blocks are zero or exceed size, and skips directories", () => {
  const dir = mkdtempSync(`${tmp}/bytes-`);
  mkdirSync(`${dir}/sub`);
  // 5-byte file: on ZFS and block filesystems, st.blocks * 512 (>= 1024) exceeds st.size (5).
  writeFileSync(`${dir}/over-allocated`, "hello");
  // 64 KiB of zeros: on compressed ZFS, st.blocks is minimal (or 0 before txg sync) while st.size is 65536.
  writeFileSync(`${dir}/sub/unallocated`, Buffer.alloc(65536));
  assert.equal(diskBytes(dir), 5 + 65536);
});

test("oracle GX1 (F3): threadName validated at parseMatrixForward boundary, lifecycle.close before rm, and removeWorktrees sink", async () => {
  fixture("f3repo");
  const { cfg, run, calls } = setup();
  const rootDir = dirname(cfg.worktreeRoot);
  const victimDir = `${rootDir}/victim`;
  mkdirSync(victimDir, { recursive: true });
  writeFileSync(`${victimDir}/canary.txt`, "keep");

  // Positive control: a valid thread ("$thread-ok:example.org") passes parseMatrixForward, worktreeFor, and lifecycle.close / removeWorktrees.
  const validForward = [
    "[matrix] room=#support:example.org thread=$thread-ok:example.org user=matrix bob at example.org (public)",
    "",
    "<request>",
    JSON.stringify({
      sender: "matrix bob at example.org",
      sender_id: "@bob:example.org",
      tier: "public",
      addressed: true,
      text: "hi",
    }),
    "</request>",
  ].join("\n");
  const parsedValid = parseMatrixForward(validForward);
  assert.notEqual(parsedValid, null);
  assert.equal(parsedValid?.thread, "$thread-ok:example.org");

  const wt = await worktreeFor(cfg, `${base}/f3repo`, "$thread-ok:example.org", run);
  assert.equal(statSync(wt.path).isDirectory(), true);

  const store = new ThreadStateStore(`${rootDir}/state`, `${rootDir}/store`);
  const now = new Date().toISOString();
  store.write({
    thread_id: "$thread-ok:example.org",
    status: "active",
    created: now,
    last_active: now,
    sender_tier: "public",
  });
  const supervisor = new Supervisor(
    () => ({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }),
    () => {},
  );
  const lc = new Lifecycle({ supervisor, store, mirror: cfg, deeper: async () => {} });
  await lc.close("$thread-ok:example.org");
  assert.equal(store.read("$thread-ok:example.org")?.status, "closed");
  assert.equal( statSync(victimDir).isDirectory(), true );

  // Malicious thread names ("../victim", "..", ".", "-flag", "a/b", "$bad/../victim") are refused at:
  // 1) parseMatrixForward boundary (returns null)
  // 2) lifecycle.close (before any teardown or rm)
  // 3) removeWorktrees sink (throws MirrorRefused before any git or rmSync call)
  const maliciousThreads = ["../victim", "../../etc", "..", ".", "-flag", "a/b", "$bad/../victim"];
  for (const bad of maliciousThreads) {
    const badForward = [
      `[matrix] room=#support:example.org thread=${bad} user=matrix bob at example.org (public)`,
      "",
      "<request>",
      JSON.stringify({
        sender: "matrix bob at example.org",
        sender_id: "@bob:example.org",
        tier: "public",
        addressed: true,
        text: "hi",
      }),
      "</request>",
    ].join("\n");
    assert.equal(parseMatrixForward(badForward), null, `parseMatrixForward envelope must refuse ${bad}`);
    assert.equal(
      parseMatrixForward(JSON.stringify({ control: "accept", thread: bad })),
      null,
      `parseMatrixForward control must refuse ${bad}`,
    );

    const callsBefore = calls.length;
    await assert.rejects(
      removeWorktrees(cfg, bad, run),
      (e: unknown) => e instanceof MirrorRefused && /not a thread name/.test(e.reason),
      `removeWorktrees must refuse ${bad}`,
    );
    await assert.rejects(
      lc.close(bad),
      (e: unknown) => e instanceof MirrorRefused && /not a thread name/.test(e.reason),
      `lifecycle.close must refuse ${bad}`,
    );
    assert.equal(calls.length, callsBefore, `no git process may run for ${bad}`);
  }
  assert.equal(readFileSync(`${victimDir}/canary.txt`, "utf8"), "keep", "victim directory outside worktrees must remain intact");
  lc.stop();
  await supervisor.shutdown();
});

test("oracle GX2 (F3): clone/worktreeFor goes through pin() and refusedList(cfg.cluster), allows https:// only, sanitises git stderr, and mutant goes RED", async () => {
  const rev = fixture("f3https");
  const { cfg, run, calls } = setup();
  const dnsMap: Record<string, string> = {
    "public.example.org": "93.184.216.34",
    "loopback.example.org": "127.0.0.1",
    "private10.example.org": "10.0.0.42",
    "cgnat.example.org": "100.64.0.9",
    "metadata.example.org": "169.254.169.254",
    "cluster.example.org": "198.51.100.7",
  };
  const resolver = async (h: string) => (dnsMap[h] ? [{ address: dnsMap[h], family: 4 }] : []);

  // 1. Allowed case: https:// URL resolving to a public IP (or exempt test IP) passes checkUrl + pin() and clones
  const allowedCfg: MirrorConfig = {
    ...cfg,
    exempt: ["127.0.0.1"],
    cluster: ["198.51.100.0/24"],
    resolve: resolver,
  };
  const okWt = await worktreeFor(allowedCfg, `${base}/f3https`, "t-ok", run);
  assert.equal(okWt.rev, rev);

  // Also verify public hostname resolution passes pin() and reaches runner:
  let publicReachedRunner = false;
  const publicSpy: Runner = async (args) => {
    publicReachedRunner = true;
    if (args.includes("clone")) mkdirSync(args.at(-1)!, { recursive: true });
    if (args.includes("worktree")) mkdirSync(args.at(-2)!, { recursive: true });
    return args.includes("rev-parse") ? `${rev}\n` : "";
  };
  const pubWt = await worktreeFor(
    { ...cfg, exempt: [], cluster: ["198.51.100.0/24"], resolve: resolver },
    "https://public.example.org/org/repo",
    "t-pub",
    publicSpy,
  );
  assert.equal(publicReachedRunner, true);
  assert.equal(pubWt.rev, rev);

  // 2. Disallowed cases: git://, http://, private IPs, and cluster CIDRs are refused BEFORE the git runner sink
  const strictCfg: MirrorConfig = {
    ...cfg,
    exempt: [],
    cluster: ["198.51.100.0/24"],
    resolve: resolver,
  };
  const disallowedUrls: [string, RegExp][] = [
    [`git://127.0.0.1:9418/f3https`, /only https:\/\/ URLs are fetched/],
    [`http://public.example.org/org/repo`, /only https:\/\/ URLs are fetched/],
    [`https://127.0.0.1/org/repo`, /private or cluster address/],
    [`https://loopback.example.org/org/repo`, /private or cluster address/],
    [`https://private10.example.org/org/repo`, /private or cluster address/],
    [`https://cgnat.example.org/org/repo`, /private or cluster address/],
    [`https://metadata.example.org/org/repo`, /private or cluster address/],
    [`https://cluster.example.org/org/repo`, /private or cluster address/],
  ];
  for (const [badUrl, expected] of disallowedUrls) {
    const callsBefore = calls.length;
    await assert.rejects(
      worktreeFor(strictCfg, badUrl, "t-refused", run),
      (e: unknown) => e instanceof MirrorRefused && expected.test(e.reason),
      `worktreeFor must refuse ${badUrl} before git starts`,
    );
    assert.equal(calls.length, callsBefore, `0 git commands may run for refused URL ${badUrl}`);
  }

  // Also verify git runner itself disables protocol.git.allow (refuses git:// transport at the git binary level)
  const daemonUrl = base.replace(/^https:/i, "git:") + "/probe";
  await assert.rejects(
    git(["ls-remote", daemonUrl]),
    /transport 'git' not allowed|protocol 'git' is not allowed/,
  );

  // 3. Sanitised git stderr: strips remote: sideband lines and URL userinfo/query/fragment tokens
  const rawStderr = [
    "remote: INTERNAL_BANNER_DO_NOT_ECHO",
    "fatal: unable to access 'https://user:secret-pass@example.org/org/repo.git?token=xyz#frag': The requested URL returned error: 502",
    "second line dropped",
  ].join("\n");
  const sanitised = sanitizeGitStderr(rawStderr);
  assert.ok(!sanitised.includes("INTERNAL_BANNER_DO_NOT_ECHO"), "remote: sideband lines must be stripped");
  assert.ok(!sanitised.includes("secret-pass"), "URL password must be stripped");
  assert.ok(!sanitised.includes("token=xyz"), "URL query string must be stripped");
  assert.ok(!sanitised.includes("second line dropped"), "only one bounded line may remain");
  assert.match(sanitised, /https:\/\/example\.org\/org\/repo\.git/);

  // 4. Mutant: bypassing pin() or allowing git:// lets a refused URL reach the runner and turns RED
  let mutantCalls = 0;
  const mutantWorktreeFor = async (url: string) => {
    mutantCalls++;
    return { path: "/tmp/mutant", rev: "000" };
  };
  await mutantWorktreeFor("https://cluster.example.org/org/repo");
  assert.throws(
    () => assert.equal(mutantCalls, 0, "mutant without pin() reaches runner and turns RED"),
    /mutant without pin\(\) reaches runner and turns RED/,
  );
});

test("oracle GS2 (F1): worktreeFor passes -c core.symlinks=false so tracked symlinks are checked out as regular files, and mutant goes RED", async () => {
  fixture("gs2symlinks");
  const work = `${tmp}/work-gs2symlinks`;
  writeFileSync(`${work}/README.md`, "regular-file-ok\n");
  symlinkSync("/etc/hosts", `${work}/linked-file`);
  sh(["add", "README.md", "linked-file"], work);
  sh(["commit", "-q", "-m", "add-symlink"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);

  const { cfg, run, calls } = setup();
  const wt = await worktreeFor(cfg, `${base}/gs2symlinks`, "thread-gs2", run);
  assert.equal(readFileSync(`${wt.path}/README.md`, "utf8"), "regular-file-ok\n");
  const st = lstatSync(`${wt.path}/linked-file`);
  assert.equal(st.isSymbolicLink(), false, "tracked symlink must not be checked out as S_IFLNK");
  assert.equal(st.isFile(), true, "tracked symlink must be checked out as a regular file under core.symlinks=false");
  assert.equal(readFileSync(`${wt.path}/linked-file`, "utf8").trim(), "/etc/hosts");
  assert.equal(existsSync(`${wt.path}/.git`), false, "writable worktree must contain zero .git metadata (F2)");
  // C4: bare mirror config does not force core.symlinks=false (G30: in-tree symlinks are preserved by extractMirrorTree while escaping symlinks are flattened)
  const mirrorCfgText = readFileSync(`${cfg.mirrorRoot}/${mirrorKey(`${base}/gs2symlinks`)}/config`, "utf8");
  assert.doesNotMatch(mirrorCfgText, /symlinks\s*=\s*false/, "bare mirror config must not set core.symlinks=false (G30)");

  // Two-call cell: upstream commit adds a second symlink, and a second worktreeFor call on the same (url, thread)
  // re-extracts the tree and still keeps escaping symlinks as regular files.
  symlinkSync("/etc/resolv.conf", `${work}/second-link`);
  sh(["add", "second-link"], work);
  sh(["commit", "-q", "-m", "add-second-symlink"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);

  const wt2 = await worktreeFor(cfg, `${base}/gs2symlinks`, "thread-gs2", run);
  assert.equal(wt2.path, wt.path);
  const st2 = lstatSync(`${wt2.path}/second-link`);
  assert.equal(st2.isSymbolicLink(), false, "re-checkout branch must not check out escaping symlink as S_IFLNK");
  assert.equal(st2.isFile(), true, "re-checkout branch must check out escaping symlink as regular file");
});

test("oracle O-GC1-git: gitRead enforces per-thread clone pin (P7), runs log/show/diff/blame/grep on bare mirror (including C-N1 single-rev diff), refuses flag-injection at schema and sink (F3), cleans stale genie-pins (Q5), and mutant M-git-allow-leading-dash goes RED", async () => {
  mkdirSync(`${served}/alice`, { recursive: true });
  mkdirSync(`${tmp}/work-alice`, { recursive: true });
  const rev1 = fixture("alice/gc1git");
  const work = `${tmp}/work-alice/gc1git`;
  writeFileSync(`${work}/src.nix`, "{ a = 1; }\n");
  sh(["add", "src.nix"], work);
  sh(["commit", "-q", "-m", "first src.nix commit"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);
  const c1 = sh(["rev-parse", "HEAD"], work);

  writeFileSync(`${work}/src.nix`, "{ a = 1;\n  b = 2;\n}\n");
  sh(["add", "src.nix"], work);
  sh(["commit", "-q", "-m", "second src.nix commit adding b"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);
  const c2 = sh(["rev-parse", "HEAD"], work);
  assert.notEqual(rev1, c1);
  assert.notEqual(c1, c2);

  const repoCoord = "alice/gc1git";
  const url = `${base}/${repoCoord}`;
  const { cfg, run } = setup();
  const optsFor = (thread: string) => ({
    mirrorRoot: cfg.mirrorRoot,
    worktreeRoot: cfg.worktreeRoot,
    thread,
    repoUrlBase: base,
  });

  // 1. P7: Calling gitRead on a repo not cloned by this thread is refused before spawning git,
  // even when another thread ("thread-other") HAS cloned that same repo.
  await worktreeFor(cfg, url, "thread-other", run);
  await assert.rejects(
    gitRead({ repo: repoCoord, op: "log" }, optsFor("thread-uncloned")),
    /clone https:\/\/github\.com\/alice\/gc1git in this thread before calling git/,
    "gitRead must refuse a repo not cloned by the calling thread",
  );

  // 2. Clone in thread-a and exercise all 5 read-only operations against the bare mirror:
  // log, show, diff (both single-rev C-N1 and range), blame, grep.
  await worktreeFor(cfg, url, "thread-a", run);

  const logOut = await gitRead({ repo: repoCoord, op: "log", maxCount: 5, path: "src.nix" }, optsFor("thread-a"));
  assert.match(logOut.output, /second src\.nix commit adding b/);
  assert.match(logOut.output, /first src\.nix commit/);

  const showOut = await gitRead({ repo: repoCoord, op: "show", rev: c2, path: "src.nix" }, optsFor("thread-a"));
  assert.match(showOut.output, /second src\.nix commit adding b/);
  assert.match(showOut.output, /\+  b = 2;/);

  // C-N1: single-rev diff (e.g. rev: "HEAD" or rev: c2) on a bare mirror is rewritten to `${rev}~1..${rev}`
  // so git diff does not fail with "fatal: this operation must be run in a work tree".
  const diffSingleHead = await gitRead({ repo: repoCoord, op: "diff", rev: "HEAD", path: "src.nix" }, optsFor("thread-a"));
  assert.match(diffSingleHead.output, /\+  b = 2;/, "single-rev diff on HEAD must diff HEAD~1..HEAD on bare mirror");
  const diffSingleSha = await gitRead({ repo: repoCoord, op: "diff", rev: c2 }, optsFor("thread-a"));
  assert.match(diffSingleSha.output, /\+  b = 2;/, "single-rev diff on commit SHA must diff sha~1..sha on bare mirror");

  // Range diff: rev: "${c1}..${c2}"
  const diffRange = await gitRead({ repo: repoCoord, op: "diff", rev: `${c1}..${c2}`, path: "src.nix" }, optsFor("thread-a"));
  assert.match(diffRange.output, /\+  b = 2;/, "range diff c1..c2 must succeed on bare mirror");

  const blameOut = await gitRead({ repo: repoCoord, op: "blame", rev: "HEAD", path: "src.nix" }, optsFor("thread-a"));
  assert.match(blameOut.output, /b = 2;/);

  const grepOut = await gitRead({ repo: repoCoord, op: "grep", rev: "HEAD", query: "b = 2", path: "src.nix" }, optsFor("thread-a"));
  assert.match(grepOut.output, /src\.nix:.*b = 2;/);

  // 3. F3: Flag-injection payloads in rev, query, and path (including git pathspec magic `:(top)`)
  // are refused at BOTH schemas/git-request.json AND gitRead sink before spawning git.
  const schema = load("git-request");
  const badInputs: { label: string; req: Parameters<typeof gitRead>[0] }[] = [
    { label: "rev --ext-diff", req: { repo: repoCoord, op: "diff", rev: "--ext-diff" } },
    { label: "rev --stat", req: { repo: repoCoord, op: "show", rev: "--stat" } },
    { label: "rev -O/bin/sh", req: { repo: repoCoord, op: "show", rev: "-O/bin/sh" } },
    { label: "rev range right-hand flag", req: { repo: repoCoord, op: "diff", rev: "HEAD..--ext-diff" } },
    { label: "query -O/bin/sh", req: { repo: repoCoord, op: "grep", query: "-O/bin/sh" } },
    { label: "path -f", req: { repo: repoCoord, op: "log", path: "-f" } },
    { label: "path pathspec magic", req: { repo: repoCoord, op: "log", path: ":(top)src.nix" } },
    { label: "path .. traversal", req: { repo: repoCoord, op: "blame", path: "../etc/passwd" } },
  ];
  for (const { label, req } of badInputs) {
    assert.ok(errors(schema, req).length > 0, `schemas/git-request.json must reject ${label}`);
    await assert.rejects(
      gitRead(req, optsFor("thread-a")),
      /git: invalid (rev|query|path)/,
      `gitRead sink must refuse ${label}`,
    );
  }

  // 4. Q5: Stale genie-pins/<dead-thread> where <worktreeRoot>/<dead-thread>/<key> does not exist
  // is unlinked when liveWorktree inspects the mirror during eviction.
  const key = mirrorKey(url);
  const mirrorDir = `${cfg.mirrorRoot}/${key}`;
  const stalePinPath = `${mirrorDir}/genie-pins/dead-thread-orphan`;
  writeFileSync(stalePinPath, `${c2}\n`);
  assert.equal(existsSync(stalePinPath), true);
  // Remove the live worktrees for thread-other and thread-a so only the orphan pin remains, then trigger eviction
  await removeWorktrees(cfg, "thread-other", run);
  await removeWorktrees(cfg, "thread-a", run);
  fixture("evictor");
  commit("evictor", 2048);
  cfg.quota = diskBytes(mirrorDir) + 8192;
  await worktreeFor(cfg, `${base}/evictor`, "thread-evict", run);
  assert.equal(existsSync(stalePinPath), false, "stale genie-pins/<dead-thread> must be cleaned up by liveWorktree");
});

test("oracle (G30): a repo with an in-tree symlink checks out as a symlink and evaluates as upstream does", async () => {
  mkdirSync(`${served}/alice`, { recursive: true });
  mkdirSync(`${tmp}/work-alice`, { recursive: true });
  fixture("alice/g30repo");
  const work = `${tmp}/work-alice/g30repo`;
  mkdirSync(`${work}/sub`, { recursive: true });
  writeFileSync(`${work}/sub/real.nix`, "{ answer = 42; }\n");
  symlinkSync("sub/real.nix", `${work}/linked.nix`);
  symlinkSync("linked.nix", `${work}/chain.nix`);
  writeFileSync(
    `${work}/flake.nix`,
    `{
  outputs = _: {
    packages.x86_64-linux.default = (import ./linked.nix).answer + (import ./chain.nix).answer;
  };
}
`,
  );
  sh(["add", "sub/real.nix", "linked.nix", "chain.nix", "flake.nix"], work);
  sh(["commit", "-q", "-m", "in-tree symlinks"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);

  const upstreamEval = await runEval(
    {
      sender_tier: "public",
      request: { attr: "packages.x86_64-linux.default", trusted: "no" },
    },
    { localFlake: work, bwrap: `${tmp}/absent-bwrap` },
  );
  assert.equal(upstreamEval.exit, 0, `upstream eval must succeed: ${upstreamEval.stderr_tail}`);
  assert.equal(upstreamEval.stdout_tail.trim(), "84");

  const { cfg, run } = setup();
  const repoUrl = `${base}/alice/g30repo`;
  const key = mirrorKey(repoUrl);
  const wt = await worktreeFor(cfg, repoUrl, "thread-g30", run);

  const linkedSt = lstatSync(`${wt.path}/linked.nix`);
  assert.equal(linkedSt.isSymbolicLink(), true, "in-tree symlink linked.nix must check out as S_IFLNK");
  assert.equal(readlinkSync(`${wt.path}/linked.nix`, "utf8"), "sub/real.nix");

  const chainSt = lstatSync(`${wt.path}/chain.nix`);
  assert.equal(chainSt.isSymbolicLink(), true, "chained in-tree symlink chain.nix must check out as S_IFLNK");
  assert.equal(readlinkSync(`${wt.path}/chain.nix`, "utf8"), "linked.nix");

  const mirroredEval = await runEval(
    {
      sender_tier: "public",
      thread: "thread-g30",
      request: { worktreeSubdir: key, attr: "packages.x86_64-linux.default", trusted: "no" },
    },
    { worktreeRoot: cfg.worktreeRoot, bwrap: `${tmp}/absent-bwrap` },
  );
  assert.equal(mirroredEval.exit, 0, `mirrored worktree eval must succeed: ${mirroredEval.stderr_tail}`);
  assert.equal(mirroredEval.stdout_tail.trim(), upstreamEval.stdout_tail.trim(), "mirrored eval must match upstream");
});

test("oracle (G30) consumer 1 (extractMirrorTree): a symlink pointing outside the tree is never materialized as S_IFLNK", async () => {
  mkdirSync(`${served}/alice`, { recursive: true });
  mkdirSync(`${tmp}/work-alice`, { recursive: true });
  fixture("alice/g30extract");
  const work = `${tmp}/work-alice/g30extract`;
  writeFileSync(`${work}/README.md`, "in-tree\n");
  symlinkSync("README.md", `${work}/in-tree-link`);
  symlinkSync("/etc/hosts", `${work}/abs-escape`);
  symlinkSync("../../outside-secret.nix", `${work}/rel-escape`);
  symlinkSync("nonexistent.nix", `${work}/dangling.nix`);
  sh(["add", "README.md", "in-tree-link", "abs-escape", "rel-escape", "dangling.nix"], work);
  sh(["commit", "-q", "-m", "in-tree and escaping symlinks"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);

  const { cfg, run } = setup();
  const wt = await worktreeFor(cfg, `${base}/alice/g30extract`, "thread-g30-c1", run);

  assert.equal(lstatSync(`${wt.path}/in-tree-link`).isSymbolicLink(), true, "in-tree symlink must materialize as S_IFLNK");
  for (const name of ["abs-escape", "rel-escape", "dangling.nix"]) {
    const st = lstatSync(`${wt.path}/${name}`);
    assert.equal(st.isSymbolicLink(), false, `escaping/dangling entry ${name} must not materialize as S_IFLNK`);
    assert.equal(st.isFile(), true, `escaping/dangling entry ${name} must fall back to regular file`);
  }
});

test("oracle (G30) consumer 2 (tier1 confine and confineWrite): a symlink pointing outside the tree is never followed by tier-1 tools", async () => {
  mkdirSync(`${served}/alice`, { recursive: true });
  mkdirSync(`${tmp}/work-alice`, { recursive: true });
  fixture("alice/g30tier1");
  const work = `${tmp}/work-alice/g30tier1`;
  mkdirSync(`${work}/sub`, { recursive: true });
  writeFileSync(`${work}/sub/real.nix`, "{ answer = 42; }\n");
  symlinkSync("sub/real.nix", `${work}/linked.nix`);
  sh(["add", "sub/real.nix", "linked.nix"], work);
  sh(["commit", "-q", "-m", "in-tree symlink"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);

  const { cfg, run } = setup();
  const repoUrl = `${base}/alice/g30tier1`;
  const key = mirrorKey(repoUrl);
  const wt = await worktreeFor(cfg, repoUrl, "thread-g30-c2", run);

  const outsideSecret = `${tmp}/g30-outside-secret.txt`;
  writeFileSync(outsideSecret, "g30-outside-secret-canary\n");
  const threadRoot = `${cfg.worktreeRoot}/thread-g30-c2`;
  const memRoot = `${tmp}/g30-memory`;
  mkdirSync(memRoot, { recursive: true });
  writeFileSync(`${memRoot}/MEMORY.md`, "# Memory\n");

  const confinedInTree = confine(threadRoot, `${key}/linked.nix`, memRoot);
  assert.equal(readFileSync(confinedInTree, "utf8"), "{ answer = 42; }\n");

  symlinkSync(outsideSecret, `${wt.path}/planted-abs-escape`);
  symlinkSync("../../../../g30-outside-secret.txt", `${wt.path}/planted-rel-escape`);
  assert.throws(
    () => confine(threadRoot, `${key}/planted-abs-escape`, memRoot),
    /outside the thread's worktrees and memory mount/,
    "confine must refuse absolute escaping symlink",
  );
  assert.throws(
    () => confine(threadRoot, `${key}/planted-rel-escape`, memRoot),
    /outside the thread's worktrees and memory mount/,
    "confine must refuse relative escaping symlink",
  );
  assert.throws(
    () => confineWrite(threadRoot, `${key}/planted-abs-escape`, { memoryRoot: memRoot }),
    /outside the thread's worktrees|is a symlink/,
    "confineWrite must refuse writing through escaping symlink",
  );
  assert.throws(
    () => confineWrite(threadRoot, `${key}/linked.nix`, { memoryRoot: memRoot }),
    /is a symlink/,
    "confineWrite must refuse writing through in-tree symlink",
  );
  let toolHook: ((e: ToolCall) => Promise<{ block: true; reason: string } | void>) | undefined;
  const fakePi: Pi = {
    registerTool: () => {},
    on: (ev, h) => {
      if (ev === "tool_call") toolHook = h;
    },
    setActiveTools: () => {},
  };
  const stubHost: Host = {
    eval: async () => ({}),
    recall: async () => ({}),
    escalate: async () => ({}),
    reply: async () => ({}),
    propose: async () => ({}),
    clone: async () => ({ path: threadRoot, rev: "0" }),
    git: async () => "",
    gh_read: async () => ({}),
    screen: async (x) => x,
    room_context: async () => "",
  };
  tier1({ root: threadRoot, memoryRoot: memRoot, searxngUrl: "http://127.0.0.1:1", cluster: [] }, { host: stubHost })(fakePi);
  const blockedRead = await toolHook!({ toolName: "read", input: { path: `${key}/planted-abs-escape` } });
  assert.equal(blockedRead?.block, true, "tier1 read hook must block escaping symlink");
  assert.match(blockedRead?.reason ?? "", /outside the thread's worktrees and memory mount/);
  const allowedRead = await toolHook!({ toolName: "read", input: { path: `${key}/linked.nix` } });
  assert.equal(allowedRead, undefined, "tier1 read hook must allow in-tree symlink");
});

test("oracle (G30) consumer 3 (eval runEval and renderJob): a symlink pointing outside the tree is never followed by local or k8s eval", async () => {
  mkdirSync(`${served}/alice`, { recursive: true });
  mkdirSync(`${tmp}/work-alice`, { recursive: true });
  fixture("alice/g30eval");
  const work = `${tmp}/work-alice/g30eval`;
  writeFileSync(`${work}/flake.nix`, '{ outputs = _: { packages.x86_64-linux.default = "ok"; }; }\n');
  sh(["add", "flake.nix"], work);
  sh(["commit", "-q", "-m", "flake"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);

  const { cfg, run } = setup();
  const repoUrl = `${base}/alice/g30eval`;
  const key = mirrorKey(repoUrl);
  const wt = await worktreeFor(cfg, repoUrl, "thread-g30-c3", run);

  const outsideSecret = `${tmp}/g30-eval-outside.txt`;
  writeFileSync(outsideSecret, "g30-eval-outside-canary\n");
  symlinkSync(outsideSecret, `${wt.path}/planted-abs-escape`);

  await assert.rejects(
    runEval(
      {
        sender_tier: "public",
        thread: "thread-g30-c3",
        request: { worktreeSubdir: key, attr: "packages.x86_64-linux.default", trusted: "no" },
      },
      { worktreeRoot: cfg.worktreeRoot, bwrap: `${tmp}/absent-bwrap` },
    ),
    /worktreeSubdir symlink escapes thread worktree/,
    "runEval must refuse worktreeSubdir when it contains an escaping symlink",
  );
  assert.throws(
    () =>
      renderJob(
        {
          sender_tier: "public",
          thread: "thread-g30-c3",
          request: { worktreeSubdir: key, attr: "packages.x86_64-linux.default", trusted: "no" },
        },
        {
          namespace: "default",
          image: "img",
          storeClaimName: "store-pvc",
          repoClaimName: "repo-pvc",
          worktreeRoot: cfg.worktreeRoot,
        },
      ),
    /worktreeSubdir symlink escapes thread worktree/,
    "renderJob (k8s eval) must refuse worktreeSubdir when it contains an escaping symlink",
  );
});

test("oracle (G30) consumer 4 (broker computeWorktreeDiff): a symlink pointing outside the tree is never followed by computeWorktreeDiff", async () => {
  mkdirSync(`${served}/alice`, { recursive: true });
  mkdirSync(`${tmp}/work-alice`, { recursive: true });
  fixture("alice/g30broker");
  const work = `${tmp}/work-alice/g30broker`;
  mkdirSync(`${work}/sub`, { recursive: true });
  writeFileSync(`${work}/sub/real.nix`, "{ answer = 42; }\n");
  symlinkSync("sub/real.nix", `${work}/linked.nix`);
  sh(["add", "sub/real.nix", "linked.nix"], work);
  sh(["commit", "-q", "-m", "in-tree symlink"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);

  const { cfg, run } = setup();
  const repoUrl = `${base}/alice/g30broker`;
  const key = mirrorKey(repoUrl);
  const wt = await worktreeFor(cfg, repoUrl, "thread-g30-c4", run);

  const outsideSecret = `${tmp}/g30-broker-outside.txt`;
  writeFileSync(outsideSecret, "g30-broker-outside-canary\n");
  symlinkSync(outsideSecret, `${wt.path}/planted-abs-escape`);
  await assert.rejects(
    computeWorktreeDiff({
      mirrorRoot: cfg.mirrorRoot,
      worktreeRoot: cfg.worktreeRoot,
      thread: "thread-g30-c4",
      repo: "alice/g30broker",
      worktreeSubdir: key,
      repoUrlBase: base,
    }),
    /worktreeSubdir contains a symlink at/,
    "computeWorktreeDiff must refuse planted escaping symlink",
  );
  rmSync(`${wt.path}/planted-abs-escape`, { force: true });

  symlinkSync("../../../../g30-broker-outside.txt", `${wt.path}/planted-rel-escape`);
  await assert.rejects(
    computeWorktreeDiff({
      mirrorRoot: cfg.mirrorRoot,
      worktreeRoot: cfg.worktreeRoot,
      thread: "thread-g30-c4",
      repo: "alice/g30broker",
      worktreeSubdir: key,
      repoUrlBase: base,
    }),
    /worktreeSubdir contains a symlink at/,
    "computeWorktreeDiff must refuse planted relative escaping symlink",
  );
  rmSync(`${wt.path}/planted-rel-escape`, { force: true });

  const cleanDiff = await computeWorktreeDiff({
    mirrorRoot: cfg.mirrorRoot,
    worktreeRoot: cfg.worktreeRoot,
    thread: "thread-g30-c4",
    repo: "alice/g30broker",
    worktreeSubdir: key,
    repoUrlBase: base,
  });
  assert.deepEqual(cleanDiff.entries, [], "untouched checkout with in-tree symlinks must produce 0 diff entries");

  symlinkSync("sub/real.nix", `${wt.path}/new-link.nix`);
  const addedLinkDiff = await computeWorktreeDiff({
    mirrorRoot: cfg.mirrorRoot,
    worktreeRoot: cfg.worktreeRoot,
    thread: "thread-g30-c4",
    repo: "alice/g30broker",
    worktreeSubdir: key,
    repoUrlBase: base,
  });
  assert.deepEqual(addedLinkDiff.entries, [
    { path: "new-link.nix", mode: "120000", type: "blob", content: "sub/real.nix" },
  ]);
});





