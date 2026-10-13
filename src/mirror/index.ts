// The mirror fetcher (design §6, Git mirror cache): bare mirrors keyed by repository URL, and a
// worktree per thread checked out from them. It is what tier 1's `clone` asks for; tier 1 never
// runs git. Only https:// and git:// URLs are fetched, and never with credentials.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

export interface MirrorConfig {
  mirrorRoot: string;
  worktreeRoot: string;
  // Bytes one mirror may hold on disk; a fetch that passes it is killed and the mirror removed,
  // unless a live worktree pins it.
  fetchCap?: number;
  // Bytes all mirrors together may hold once a fetch is done; least-recently-used ones are evicted.
  quota?: number;
}

// 2 GiB: above the bare mirror of any ordinary project (and of every gen library), below the
// monorepos (nixpkgs, linux) whose sources an eval reaches through its flake inputs instead, and
// a small share of the mirror PVC so one URL cannot take the quota P7 evicts against.
export const DEFAULT_FETCH_CAP = 2 * 1024 ** 3;
// 32 GiB: sixteen mirrors at the fetch cap. The mirror PVC is sized at the quota plus one fetch
// cap, since a fetch lands before eviction makes room for it.
export const DEFAULT_QUOTA = 32 * 1024 ** 3;
// How often a running fetch's directory is measured; the overshoot is what git writes in one tick.
const CAP_POLL_MS = 20;

// A request refused before any git process starts.
export class MirrorRefused extends Error {
  readonly reason: string;
  constructor(reason: string, subject: string) {
    super(`mirror refused ${JSON.stringify(subject)}: ${reason}`);
    this.reason = reason;
  }
}

// A fetch that passed its cap, killed and its mirror removed (or, when pinned, left as it was), or a
// pinned mirror already past its cap.
export class MirrorOverCap extends Error {
  readonly bytes: number;
  readonly cap: number;
  constructor(bytes: number, cap: number, url: string) {
    super(`mirror of ${JSON.stringify(url)} passed its ${cap}-byte cap at ${bytes} bytes`);
    this.bytes = bytes;
    this.cap = cap;
  }
}

// A fetch refused because the mirrors pinned by live worktrees leave it no room under the quota.
export class MirrorOverQuota extends Error {
  readonly reason: string;
  constructor(pinned: number, quota: number, url: string) {
    const reason = `this mirror and those pinned by live worktrees hold ${pinned} bytes, past the ${quota}-byte quota`;
    super(`mirror of ${JSON.stringify(url)} refused: ${reason}`);
    this.reason = reason;
  }
}

// Runs git with argv and resolves to its stdout; an abort kills it. Tests substitute a spy.
export type Runner = (args: string[], signal?: AbortSignal) => Promise<string>;

let emptyHome: string | undefined;

export const git: Runner = (args, signal) => {
  emptyHome ??= mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-mirror-home-`);
  const env = {
    PATH: process.env.PATH,
    HOME: emptyHome,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const config = [
    "protocol.allow=never",
    "protocol.https.allow=always",
    "protocol.git.allow=always",
    "protocol.file.allow=never",
    "credential.helper=",
  ].flatMap((c) => ["-c", c]);
  return new Promise((resolve, reject) => {
    // Its own process group, so an abort also kills the transport and index-pack git spawns.
    const child = spawn("git", [...config, ...args], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {} // the group has already exited
    };
    if (signal?.aborted) kill();
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(" ")}: ${stderr.trim() || `exit ${code ?? "killed"}`}`));
    });
  });
};

// Bytes under dir as allocated on disk, or as written where allocation lags (whichever is more).
export function diskBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    try {
      const st = lstatSync(`${e.parentPath}/${e.name}`);
      n += Math.max(st.size, st.blocks * 512);
    } catch {} // removed by git between the listing and the stat
  }
  return n;
}

// Raises MirrorRefused unless url is an https:// or git:// URL with a host and no userinfo.
export function checkUrl(url: string): URL {
  if (!/^(https|git):\/\//i.test(url)) throw new MirrorRefused("only https:// and git:// URLs are fetched", url);
  if (/[\s\x00-\x1f\x7f]/.test(url)) throw new MirrorRefused("whitespace or a control character", url);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new MirrorRefused("not a URL", url);
  }
  if (u.protocol !== "https:" && u.protocol !== "git:") throw new MirrorRefused("only https:// and git:// URLs are fetched", url);
  if (u.username || u.password) throw new MirrorRefused("credentials in the URL", url);
  if (!u.hostname) throw new MirrorRefused("no host", url);
  if (u.search || u.hash) throw new MirrorRefused("a query or fragment", url);
  return u;
}

// Scheme and host are lowercased by the URL parser; a trailing slash and `.git` are dropped.
export const normalise = (url: string): string =>
  checkUrl(url).href.replace(/\/+$/, "").replace(/\.git$/, "");

export const mirrorKey = (url: string): string => createHash("sha256").update(normalise(url)).digest("hex");

const threadName = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// Runs git while measuring watched on disk, killing git once it passes cap. Measured during the
// fetch, never from a size the remote declares, and once more after it for a runner that ignores
// the signal.
async function capped(run: Runner, args: string[], watched: string, cap: number, url: string): Promise<void> {
  const abort = new AbortController();
  let over = 0;
  const tick = setInterval(() => {
    const n = diskBytes(watched);
    if (n > cap && !over) {
      over = n;
      abort.abort();
    }
  }, CAP_POLL_MS);
  try {
    await run(args, abort.signal);
  } catch (e) {
    if (!over) throw e;
  } finally {
    clearInterval(tick);
  }
  if (!over) {
    const n = diskBytes(watched);
    if (n > cap) over = n;
  }
  if (over) throw new MirrorOverCap(over, cap, url);
}

// The fetch into one mirror, and the one place a fetch-size cap or a quota wraps it. The cap bounds
// the mirror, not one fetch's delta. A mirror whose fetch passes it is removed whole, unless a live
// worktree pins it: then only the killed fetch's temporary pack goes, and the mirror is left as it
// was before the fetch. A pinned mirror already past the cap is refused before git starts.
async function fetchMirror(run: Runner, mirrorRoot: string, dir: string, url: string, cap: number): Promise<void> {
  if (existsSync(dir)) {
    const pinned = liveWorktree(dir);
    const held = pinned ? diskBytes(dir) : 0;
    if (held > cap) throw new MirrorOverCap(held, cap, url);
    // Forced pack mode and no FETCH_HEAD, so a killed fetch leaves only objects/pack/tmp_pack_*;
    // no --prune, which drops refs before the transfer, so a killed fetch leaves refs untouched.
    try {
      await capped(run, ["-C", dir, "-c", "fetch.unpackLimit=1", "fetch", "--no-write-fetch-head", "origin"], dir, cap, url);
    } catch (e) {
      if (!(e instanceof MirrorOverCap)) throw e;
      const doomed = pinned ? readdirSync(`${dir}/objects/pack`).filter((f) => f.startsWith("tmp_pack_")).map((f) => `${dir}/objects/pack/${f}`) : [dir];
      for (const p of doomed) rmSync(p, { recursive: true, force: true });
      throw e;
    }
    // A second round-trip that lists the remote's refs and deletes ours it lacks; it fetches no objects.
    await run(["-C", dir, "remote", "prune", "origin"]);
    return;
  }
  // Cloned beside the mirror and renamed into place, so a failed clone leaves no mirror.
  const tmp = mkdtempSync(`${mirrorRoot}/.clone-`);
  try {
    await capped(run, ["clone", "--mirror", "--", url, `${tmp}/m`], tmp, cap, url);
    renameSync(`${tmp}/m`, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// A mirror's last use, the last fetch into it or worktree made from it, is this marker's mtime: it
// lives on the mirror PVC, so the order survives a restart.
const USED = "genie-used";
const touch = (dir: string) => writeFileSync(`${dir}/${USED}`, "");
const usedAt = (dir: string) => statSync(`${dir}/${USED}`, { throwIfNoEntry: false })?.mtimeMs ?? 0;

// Whether a worktree made from the mirror still exists. Read from git's own registry in the mirror,
// <dir>/worktrees/*/gitdir, the record that makes the worktree work; a removed one goes stale there,
// as `git worktree prune` would judge it.
export function liveWorktree(dir: string): boolean {
  if (!existsSync(`${dir}/worktrees`)) return false;
  return readdirSync(`${dir}/worktrees`).some((w) => {
    const gitdir = `${dir}/worktrees/${w}/gitdir`;
    return existsSync(gitdir) && existsSync(readFileSync(gitdir, "utf8").trim());
  });
}

// Holds the mirrors under quota after a fetch into keep, evicting least-recently-used first. A
// mirror with a live worktree, one another call holds, and keep itself are pinned. When the pinned
// ones alone pass the quota nothing is evicted, keep is removed unless it is pinned by a worktree,
// and the fetch is refused.
function evict(mirrorRoot: string, keep: string, quota: number, url: string): void {
  const mirrors = readdirSync(mirrorRoot)
    .filter((k) => !k.startsWith("."))
    .map((k) => {
      const dir = `${mirrorRoot}/${k}`;
      return { dir, bytes: diskBytes(dir), used: usedAt(dir), pinned: k === keep || locks.has(k) || liveWorktree(dir) };
    });
  let total = mirrors.reduce((n, m) => n + m.bytes, 0);
  const pinned = mirrors.filter((m) => m.pinned).reduce((n, m) => n + m.bytes, 0);
  if (pinned > quota) {
    const dir = `${mirrorRoot}/${keep}`;
    if (!liveWorktree(dir)) rmSync(dir, { recursive: true, force: true });
    throw new MirrorOverQuota(pinned, quota, url);
  }
  for (const m of mirrors.filter((m) => !m.pinned).sort((a, b) => a.used - b.used)) {
    if (total <= quota) break;
    rmSync(m.dir, { recursive: true, force: true });
    total -= m.bytes;
  }
}

// ponytail: an in-process lock per mirror; a lock file is owed if a second fetcher process ever
// shares mirrorRoot.
const locks = new Map<string, Promise<unknown>>();

function locked<T>(key: string, f: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(f, f);
  const settled = next.catch(() => {});
  locks.set(key, settled);
  settled.then(() => locks.get(key) === settled && locks.delete(key));
  return next;
}

// Removes every worktree the thread holds, from git's registry in its mirror as well as from disk,
// which unpins the mirror for eviction. Keyed as worktreeFor keys them: <worktreeRoot>/<thread>/<key>
// from the mirror <mirrorRoot>/<key>. Shared by C4's close and P3's collection.
export async function removeWorktrees(cfg: Pick<MirrorConfig, "mirrorRoot" | "worktreeRoot">, thread: string, run: Runner = git): Promise<void> {
  const dir = `${cfg.worktreeRoot}/${thread}`;
  for (const key of existsSync(dir) ? readdirSync(dir) : []) {
    const m = `${cfg.mirrorRoot}/${key}`;
    if (existsSync(m)) await run(["-C", m, "worktree", "remove", "--force", `${dir}/${key}`]);
    else rmSync(`${dir}/${key}`, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
}

// The thread's worktree of url, at the mirror's default branch head after a fresh fetch.
export async function worktreeFor(
  cfg: MirrorConfig,
  url: string,
  thread: string,
  run: Runner = git,
): Promise<{ path: string; rev: string }> {
  checkUrl(url);
  if (!threadName.test(thread)) throw new MirrorRefused("not a thread name", thread);
  for (const root of [cfg.mirrorRoot, cfg.worktreeRoot]) {
    if (!root.startsWith("/")) throw new MirrorRefused("not an absolute path", root);
  }
  const key = mirrorKey(url);
  const dir = `${cfg.mirrorRoot}/${key}`;
  const path = `${cfg.worktreeRoot}/${thread}/${key}`;
  return locked(key, async () => {
    mkdirSync(cfg.mirrorRoot, { recursive: true, mode: 0o755 });
    await fetchMirror(run, cfg.mirrorRoot, dir, url, cfg.fetchCap ?? DEFAULT_FETCH_CAP);
    touch(dir);
    evict(cfg.mirrorRoot, key, cfg.quota ?? DEFAULT_QUOTA, url);
    const rev = (await run(["-C", dir, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (existsSync(path)) {
      await run(["-C", path, "checkout", "--force", "--detach", rev]);
    } else {
      mkdirSync(`${cfg.worktreeRoot}/${thread}`, { recursive: true, mode: 0o755 });
      // --force: a removed worktree stays registered in the mirror and would refuse this path.
      await run(["-C", dir, "worktree", "add", "--force", "--detach", path, rev]);
      touch(dir);
    }
    return { path, rev };
  });
}
