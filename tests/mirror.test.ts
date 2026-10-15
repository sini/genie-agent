// The mirror fetcher's gating oracle, against fixture repositories served by a throwaway
// `git daemon` on 127.0.0.1. Run with `node --test tests/mirror.test.ts`; needs git on PATH.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { after, before, test } from "node:test";
import {
  diskBytes,
  git,
  MirrorOverCap,
  MirrorOverQuota,
  MirrorRefused,
  mirrorKey,
  worktreeFor,
  type MirrorConfig,
  type Runner,
} from "../src/mirror/index.ts";

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
function setup(fetchCap?: number, quota?: number) {
  const root = mkdtempSync(`${tmp}/case-`);
  const cfg = { mirrorRoot: `${root}/mirrors`, worktreeRoot: `${root}/worktrees`, fetchCap, quota };
  const calls: string[][] = [];
  const run: Runner = (args, signal) => {
    calls.push(args);
    return git(args, signal);
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

