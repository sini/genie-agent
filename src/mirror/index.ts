// The mirror fetcher (design §6, Git mirror cache): bare mirrors keyed by repository URL, and a
// worktree per thread checked out from them. It is what tier 1's `clone` asks for; tier 1 never
// runs git. Only https:// URLs are fetched, after resolving and refusing private or cluster
// addresses, and never with credentials.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { BlockList, isIP } from "node:net";
import { dirname, resolve } from "node:path";

const REPO_COORD_RE =
  /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\/[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

export function isValidRepoCoord(repo: unknown): repo is string {
  if (typeof repo !== "string" || !REPO_COORD_RE.test(repo) || repo.includes("..")) return false;
  const parts = repo.split("/");
  return (
    parts.length === 2 &&
    parts.every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && !seg.startsWith("-") && !seg.endsWith(".lock"))
  );
}

function isValidGitPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.startsWith("-") ||
    path.startsWith(":")
  ) {
    return false;
  }
  const parts = path.split("/");
  return parts.every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && !seg.startsWith("-"));
}

export type Address = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Address[]>;

export const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

// Loopback, this-network (0.0.0.0), RFC1918, CGNAT (the tailnet), link-local, ULA.
const refusedRanges = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

const addressFamily = (ip: string): "ipv4" | "ipv6" => (isIP(ip) === 6 ? "ipv6" : "ipv4");

// The refused addresses, plus the cluster's CIDRs. An IPv4-mapped IPv6 address is checked as its
// IPv4 address (BlockList does this).
export function refusedList(cluster: string[]): BlockList {
  const b = new BlockList();
  for (const cidr of [...refusedRanges, ...cluster]) {
    const [net, bits] = cidr.split("/");
    if (!isIP(net) || !/^\d+$/.test(bits ?? "")) throw new Error(`not a CIDR: ${cidr}`);
    b.addSubnet(net, Number(bits), addressFamily(net));
  }
  return b;
}

export interface PinOptions {
  resolve: Resolver;
  refused: BlockList;
  // Addresses let through the refusal. Tests only: production leaves it empty.
  exempt?: string[];
}

// The checked address the request connects to.
export async function pin(u: URL, o: PinOptions): Promise<Address> {
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await o.resolve(host);
  if (addrs.length === 0) throw new Error(`${host} does not resolve`);
  for (const a of addrs) {
    if (!o.exempt?.includes(a.address) && o.refused.check(a.address, addressFamily(a.address)))
      throw new Error(`refused: ${host} resolves to ${a.address}, a private or cluster address`);
  }
  return addrs[0];
}

export interface MirrorConfig {
  mirrorRoot: string;
  worktreeRoot: string;
  // Bytes one mirror may hold on disk; a fetch that passes it is killed and the mirror removed,
  // unless a live worktree pins it.
  fetchCap?: number;
  // Bytes all mirrors together may hold once a fetch is done; least-recently-used ones are evicted.
  quota?: number;
  // Cluster CIDRs refused by pin() before fetching.
  cluster?: string[];
  resolve?: Resolver;
  refused?: BlockList;
  // Addresses let through the refusal. Tests only: production leaves it empty.
  exempt?: string[];
  // Optional base URL override for mapping `owner/name` -> URL in `git` and `propose` (default "https://github.com").
  repoUrlBase?: string;
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

// Sanitises git stderr before surfacing it in an Error: drops remote sideband lines, strips URL
// userinfo/query/fragment tokens and control characters, and bounds the result to one line.
export function sanitizeGitStderr(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/[\x00-\x1f\x7f]+/g, " ").trim())
    .filter((l) => l.length > 0 && !/^remote:/i.test(l));
  if (lines.length === 0) return "";
  const cleaned = lines[0]
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (rawUrl) => {
      try {
        const parsed = new URL(rawUrl);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return "<redacted-url>";
      }
    })
    .slice(0, 200);
  return cleaned;
}

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
    "protocol.git.allow=never",
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
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {} // the group has already exited
    };
    if (signal?.aborted) kill();
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", kill);
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(" ")}: ${sanitizeGitStderr(stderr) || `exit ${code ?? "killed"}`}`));
    });
  });
};

// Apparent bytes stored under dir: the sum of st.size over regular files, skipping directories.
// The fetch cap and mirror quota bound apparent stored bytes and do not predict on-disk blocks
// (on ZFS, st.blocks is 0 before a txg sync and includes block/dnode overhead after).
export function diskBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    try {
      n += lstatSync(`${e.parentPath}/${e.name}`).size;
    } catch {} // removed by git between the listing and the stat
  }
  return n;
}

// Raises MirrorRefused unless url is an https:// URL with a host and no userinfo.
export function checkUrl(url: string): URL {
  if (!/^https:\/\//i.test(url)) throw new MirrorRefused("only https:// URLs are fetched", url);
  if (/[\s\x00-\x1f\x7f]/.test(url)) throw new MirrorRefused("whitespace or a control character", url);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new MirrorRefused("not a URL", url);
  }
  if (u.protocol !== "https:") throw new MirrorRefused("only https:// URLs are fetched", url);
  if (u.username || u.password) throw new MirrorRefused("credentials in the URL", url);
  if (!u.hostname) throw new MirrorRefused("no host", url);
  if (u.search || u.hash) throw new MirrorRefused("a query or fragment", url);
  return u;
}

// Scheme and host are lowercased by the URL parser; a trailing slash and `.git` are dropped.
export const normalise = (url: string): string =>
  checkUrl(url).href.replace(/\/+$/, "").replace(/\.git$/, "");

export const mirrorKey = (url: string): string => createHash("sha256").update(normalise(url)).digest("hex");

export const threadName = /^(?!.*\.\.)[A-Za-z0-9_$!][A-Za-z0-9._:$!-]*$/;

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
    await capped(
      run,
      ["clone", "--mirror", "--", url, `${tmp}/m`],
      tmp,
      cap,
      url,
    );
    renameSync(`${tmp}/m`, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// A mirror's last use, the last fetch into it or worktree made from it, is recorded in this marker
// on the mirror PVC as a strictly monotonic timestamp, so the order is deterministic within a coarse
// mtime tick and survives a restart.
const USED = "genie-used";
let lastUsed = 0;
function usedAt(dir: string): number {
  const p = `${dir}/${USED}`;
  if (!existsSync(p)) return 0;
  return Number(readFileSync(p, "utf8").trim()) || (statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0);
}
function touch(dir: string, mirrorRoot: string): void {
  const floor = readdirSync(mirrorRoot)
    .filter((k) => !k.startsWith("."))
    .reduce((m, k) => Math.max(m, usedAt(`${mirrorRoot}/${k}`)), lastUsed);
  lastUsed = Math.max(Date.now(), floor + 1);
  writeFileSync(`${dir}/${USED}`, `${lastUsed}\n`);
}

// Whether a worktree made from the mirror still exists. Read from <dir>/genie-pins/<thread>
// (line 1 = base rev, line 2 = checkout path), pruning stale pin files whose checkout directory
// is gone (Q5). Also checks legacy <dir>/worktrees/*/gitdir if present.
const PINS = "genie-pins";

export function readMirrorPin(dir: string, thread: string): { rev: string; path: string } | null {
  const pinFile = `${dir}/${PINS}/${thread}`;
  if (!existsSync(pinFile)) return null;
  const lines = readFileSync(pinFile, "utf8").split(/\r?\n/);
  const rev = (lines[0] ?? "").trim();
  const path = (lines[1] ?? "").trim();
  if (!rev || !path) return null;
  if (!existsSync(path)) {
    rmSync(pinFile, { force: true });
    return null;
  }
  return { rev, path };
}

export function liveWorktree(dir: string): boolean {
  let live = false;
  const pinsDir = `${dir}/${PINS}`;
  if (existsSync(pinsDir)) {
    for (const w of readdirSync(pinsDir)) {
      if (readMirrorPin(dir, w) !== null) {
        live = true;
      }
    }
  }
  if (!live && existsSync(`${dir}/worktrees`)) {
    live = readdirSync(`${dir}/worktrees`).some((w) => {
      const gitdir = `${dir}/worktrees/${w}/gitdir`;
      return existsSync(gitdir) && existsSync(readFileSync(gitdir, "utf8").trim());
    });
  }
  return live;
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

// Removes every worktree the thread holds, from <mirror>/genie-pins/<thread> as well as from disk,
// which unpins the mirror for eviction. Keyed as worktreeFor keys them: <worktreeRoot>/<thread>/<key>
// from the mirror <mirrorRoot>/<key>. Shared by C4's close and P3's collection.
export async function removeWorktrees(
  cfg: Pick<MirrorConfig, "mirrorRoot" | "worktreeRoot">,
  thread: string,
  run: Runner = git,
): Promise<void> {
  if (!threadName.test(thread)) throw new MirrorRefused("not a thread name", thread);
  if (existsSync(cfg.mirrorRoot)) {
    for (const key of readdirSync(cfg.mirrorRoot)) {
      if (key.startsWith(".")) continue;
      rmSync(`${cfg.mirrorRoot}/${key}/${PINS}/${thread}`, { force: true });
    }
  }
  const dir = `${cfg.worktreeRoot}/${thread}`;
  for (const key of existsSync(dir) ? readdirSync(dir) : []) {
    const m = `${cfg.mirrorRoot}/${key}`;
    rmSync(`${m}/${PINS}/${thread}`, { force: true });
    if (existsSync(`${m}/worktrees`)) {
      await run(["-C", m, "worktree", "remove", "--force", `${dir}/${key}`]).catch(() => {});
    }
    rmSync(`${dir}/${key}`, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
}

export interface MirrorTreeEntry {
  mode: "100644" | "100755" | "120000";
  sha: string;
  path: string;
}

// Lists tracked blob entries (100644, 100755, 120000; skipping 160000 gitlinks) from a bare mirror
// via `git --git-dir=<dir> ls-tree -r -z <rev> [-- <prefix>]` without touching any worktree.
export async function listMirrorTree(dir: string, rev: string, prefix?: string): Promise<MirrorTreeEntry[]> {
  if (!existsSync(`${dir}/objects`)) return [];
  const args = [
    "-c",
    "protocol.allow=never",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    `--git-dir=${dir}`,
    "ls-tree",
    "-r",
    "-z",
    rev,
    ...(prefix ? ["--", prefix] : []),
  ];
  const raw = await new Promise<Buffer>((resolveBuf, reject) => {
    const child = spawn("git", args, {
      cwd: "/",
      env: {
        PATH: process.env.PATH,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveBuf(Buffer.concat(out));
      else reject(new Error(`git ls-tree: ${ sanitizeGitStderr(Buffer.concat(err).toString("utf8")) || `exit ${code}` }`));
    });
  });
  const entries: MirrorTreeEntry[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0) continue;
    const rec = raw.subarray(start, i).toString("utf8");
    start = i + 1;
    const tab = rec.indexOf("\t");
    if (tab === -1) continue;
    const meta = rec.slice(0, tab).trim().split(/\s+/);
    const filePath = rec.slice(tab + 1);
    const mode = meta[0];
    const sha = meta[2];
    if (!sha || !filePath) continue;
    if (mode === "160000") continue;
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") continue;
    const segs = filePath.split("/");
    if (segs.some((s: string) => !s || s === "." || s === ".." || s === ".git")) continue;
    entries.push({ mode, sha, path: filePath });
  }
  return entries;
}

// Returns true when `linkTarget` is a relative path with no NUL byte whose lexical resolution
// from `dirname(target)` stays strictly inside `destReal`.
function isLexicallyContainedSymlink(destReal: string, target: string, linkTarget: string): boolean {
  if (linkTarget.length === 0 || linkTarget.includes("\0") || linkTarget.startsWith("/")) {
    return false;
  }
  const resolved = resolve(dirname(target), linkTarget);
  return resolved !== destReal && resolved.startsWith(`${destReal}/`);
}

// Populates `destPath` from `git --git-dir=<dir> ls-tree -r -z <rev>` + `cat-file --batch` (Gate v1 C1, G30):
// - 100644 / 100755: regular files with raw blob bytes (no .gitattributes export-ignore/export-subst/eol).
// - 120000: materialized as a symlink when its target resolves inside `destPath`, else flattened to a regular file.
// - 160000: skipped.
// Zero `.git` metadata is ever written into `destPath`.
async function extractMirrorTree(dir: string, rev: string, destPath: string): Promise<void> {
  rmSync(destPath, { recursive: true, force: true });
  mkdirSync(destPath, { recursive: true, mode: 0o755 });
  const entries = await listMirrorTree(dir, rev);
  if (entries.length === 0) return;

  const raw = await new Promise<Buffer>((resolveBuf, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "protocol.allow=never",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        `--git-dir=${dir}`,
        "cat-file",
        "--batch",
      ],
      {
        cwd: "/",
        env: {
          PATH: process.env.PATH,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveBuf(Buffer.concat(out));
      else reject(new Error(`git cat-file --batch: ${sanitizeGitStderr(Buffer.concat(err).toString("utf8")) || `exit ${code}`}`));
    });
    child.stdin.write(`${entries.map((e) => e.sha).join("\n")}\n`);
    child.stdin.end();
  });

  const destReal = realpathSync(destPath);
  const symlinks: { target: string; content: Buffer }[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nl = raw.indexOf(0x0a, offset);
    if (nl === -1) throw new Error(`cat-file --batch: truncated header for ${entry.sha}`);
    const header = raw.subarray(offset, nl).toString("utf8");
    const parts = header.split(" ");
    const size = Number.parseInt(parts[2] ?? "", 10);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`cat-file --batch: bad header ${JSON.stringify(header)}`);
    }
    const start = nl + 1;
    const end = start + size;
    if (end > raw.length) throw new Error(`cat-file --batch: truncated body for ${entry.sha}`);
    const content = raw.subarray(start, end);
    offset = end + 1; // trailing LF after each object body

    const target = `${destReal}/${entry.path}`;
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    if (entry.mode === "120000") {
      symlinks.push({ target, content });
      continue;
    }
    const fmode = entry.mode === "100755" ? 0o755 : 0o644;
    writeFileSync(target, content, { mode: fmode });
    chmodSync(target, fmode);
  }

  const placedSymlinks: { target: string; content: Buffer }[] = [];
  for (const { target, content } of symlinks) {
    const linkTarget = content.toString("utf8");
    let parentReal = "";
    try {
      parentReal = realpathSync(dirname(target));
    } catch {}
    const parentOk = parentReal === destReal || parentReal.startsWith(`${destReal}/`);
    if (
      parentOk &&
      !lstatSync(target, { throwIfNoEntry: false }) &&
      isLexicallyContainedSymlink(destReal, target, linkTarget)
    ) {
      symlinkSync(linkTarget, target);
      placedSymlinks.push({ target, content });
    } else {
      writeFileSync(target, content, { mode: 0o644 });
      chmodSync(target, 0o644);
    }
  }

  for (const { target, content } of placedSymlinks) {
    let realTarget = "";
    try {
      realTarget = realpathSync(target);
    } catch {}
    if (realTarget !== destReal && !realTarget.startsWith(`${destReal}/`)) {
      rmSync(target, { force: true });
      writeFileSync(target, content, { mode: 0o644 });
      chmodSync(target, 0o644);
    }
  }
}

// The thread's worktree of url, at the mirror's default branch head after a fresh fetch.
export async function worktreeFor(
  cfg: MirrorConfig,
  url: string,
  thread: string,
  run: Runner = git,
): Promise<{ path: string; rev: string }> {
  const u = checkUrl(url);
  if (!threadName.test(thread)) throw new MirrorRefused("not a thread name", thread);
  for (const root of [cfg.mirrorRoot, cfg.worktreeRoot]) {
    if (!root.startsWith("/")) throw new MirrorRefused("not an absolute path", root);
  }
  try {
    await pin(u, {
      resolve: cfg.resolve ?? systemResolver,
      refused: cfg.refused ?? refusedList(cfg.cluster ?? []),
      exempt: cfg.exempt,
    });
  } catch (e) {
    throw new MirrorRefused(e instanceof Error ? e.message : String(e), url);
  }
  const key = mirrorKey(url);
  const dir = `${cfg.mirrorRoot}/${key}`;
  const path = `${cfg.worktreeRoot}/${thread}/${key}`;
  return locked(key, async () => {
    mkdirSync(cfg.mirrorRoot, { recursive: true, mode: 0o755 });
    await fetchMirror(run, cfg.mirrorRoot, dir, url, cfg.fetchCap ?? DEFAULT_FETCH_CAP);
    touch(dir, cfg.mirrorRoot);
    evict(cfg.mirrorRoot, key, cfg.quota ?? DEFAULT_QUOTA, url);
    const rev = (await run(["-C", dir, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
    mkdirSync(`${cfg.worktreeRoot}/${thread}`, { recursive: true, mode: 0o755 });
    await extractMirrorTree(dir, rev, path);
    mkdirSync(`${dir}/${PINS}`, { recursive: true, mode: 0o755 });
    writeFileSync(`${dir}/${PINS}/${thread}`, `${rev}\n${path}\n`);
    touch(dir, cfg.mirrorRoot);
    return { path, rev };
  });
}

// Read-only `git` history tool over the thread-pinned bare mirror (GC1 §2.3, F3, P1, P7, Gate v1 C-N1).
export const GIT_REV_RE =
  /^[A-Za-z0-9][A-Za-z0-9_/~^-]*(?:\.[A-Za-z0-9_/~^-]+)*(?:\.\.\.?[A-Za-z0-9][A-Za-z0-9_/~^-]*(?:\.[A-Za-z0-9_/~^-]+)*)?$/;

export type GitOp = "log" | "show" | "diff" | "blame" | "grep";

export interface GitReadRequest {
  repo: string;
  op: GitOp;
  rev?: string;
  path?: string;
  query?: string;
  maxCount?: number;
}

export interface GitReadResult {
  output: string;
  truncated: boolean;
}

export type GitRequest = GitReadRequest;

export interface GitReadOptions {
  mirrorRoot: string;
  worktreeRoot: string;
  thread: string;
  // Base URL prefix for mapping `owner/name` -> `<repoUrlBase>/owner/name` (default: "https://github.com").
  repoUrlBase?: string;
  git?: Runner;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function gitRead(req: GitReadRequest, opts: GitReadOptions): Promise<GitReadResult> {
  if (!req || typeof req !== "object") throw new Error("git: request must be an object");
  if (!isValidRepoCoord(req.repo)) {
    throw new Error(`git: invalid repo coordinate: ${String(req.repo)}`);
  }
  const op = req.op;
  if (op !== "log" && op !== "show" && op !== "diff" && op !== "blame" && op !== "grep") {
    throw new Error(`git: unsupported op: ${String(op)}`);
  }

  const rev = req.rev ?? "HEAD";
  if (typeof rev !== "string" || rev.length < 1 || rev.length > 256 || !GIT_REV_RE.test(rev)) {
    throw new Error(`git: invalid rev: ${String(rev)}`);
  }

  const path = req.path;
  if (op === "blame" && (typeof path !== "string" || path.length === 0)) {
    throw new Error("git: path is required for blame");
  }
  if (path !== undefined) {
    if (!isValidGitPath(path)) {
      throw new Error(`git: invalid path: ${String(path)}`);
    }
  }

  const query = req.query;
  if (op === "grep" && (typeof query !== "string" || query.length === 0)) {
    throw new Error("git: query is required for grep");
  }
  if (query !== undefined) {
    if (op !== "grep" && op !== "log") {
      throw new Error(`git: query is not permitted for op ${op}`);
    }
    if (
      typeof query !== "string" ||
      query.length < 1 ||
      query.length > 256 ||
      query.startsWith("-") ||
      /[\x00-\x1f\x7f]/.test(query)
    ) {
      throw new Error(`git: invalid query: ${String(query)}`);
    }
  }

  const rawMax = req.maxCount ?? 20;
  if (typeof rawMax !== "number" || !Number.isInteger(rawMax) || rawMax < 1 || rawMax > 100) {
    throw new Error(`git: invalid maxCount: ${String(rawMax)}`);
  }
  const maxCount = Math.min(100, Math.max(1, rawMax));

  const baseHost = (opts.repoUrlBase ?? "https://github.com").replace(/\/+$/, "");
  const url = `${baseHost}/${req.repo}`;
  const key = mirrorKey(url);
  const bareDir = `${opts.mirrorRoot}/${key}`;
  const pinInfo = readMirrorPin(bareDir, opts.thread);
  const threadCheckout = `${opts.worktreeRoot}/${opts.thread}/${key}`;
  if (!pinInfo || !existsSync(threadCheckout) || !existsSync(bareDir)) {
    throw new Error(`clone https://github.com/${req.repo} in this thread before calling git`);
  }

  const base = [
    "-c",
    "protocol.allow=never",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "--no-pager",
    `--git-dir=${bareDir}`,
  ];
  const endOpts = ["--end-of-options"];
  // Gate v1 C-N1: `git --git-dir=<bare> diff <single-rev>` fails with rc 128 ("must be run in a work tree");
  // rewrite a single rev (without `..` or `...`) to `${rev}~1..${rev}`.
  const diffRev = rev.includes("..") ? rev : `${rev}~1..${rev}`;

  let argv: string[];
  switch (op) {
    case "log":
      argv = [
        ...base,
        "log",
        "--no-ext-diff",
        "--no-textconv",
        `-n${maxCount}`,
        "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n    %s%n",
        ...(query ? [`-S${query}`] : []),
        ...endOpts,
        rev,
        "--",
        ...(path ? [path] : []),
      ];
      break;
    case "show":
      argv = [
        ...base,
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B",
        ...endOpts,
        rev,
        "--",
        ...(path ? [path] : []),
      ];
      break;
    case "diff":
      argv = [...base, "diff", "--no-ext-diff", "--no-textconv", ...endOpts, diffRev, "--", ...(path ? [path] : [])];
      break;
    case "blame":
      argv = [...base, "blame", "-L", "1,200", rev, "--", path!];
      break;
    case "grep":
      argv = [
        ...base,
        "grep",
        "-n",
        "-I",
        `--max-count=${maxCount}`,
        "-e",
        query!,
        ...endOpts,
        rev,
        "--",
        ...(path ? [path] : []),
      ];
      break;
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 16_384;
  emptyHome ??= mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-mirror-home-`);

  return new Promise<GitReadResult>((resolveRes, reject) => {
    const child = spawn("git", argv, {
      cwd: "/",
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: emptyHome,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CEILING_DIRECTORIES: opts.worktreeRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let stderr = "";
    let timedOut = false;

    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (totalBytes < maxBytes) {
        const take = Math.min(d.length, maxBytes - totalBytes);
        chunks.push(d.subarray(0, take));
        totalBytes += take;
        if (take < d.length) truncated = true;
      } else {
        truncated = true;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      if (stderr.length < 4096) stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git ${op}: timed out after ${timeoutMs}ms`));
        return;
      }
      // `git grep` exits 1 when 0 lines match; return empty output rather than throwing.
      if (code === 0 || (op === "grep" && code === 1 && !stderr.trim())) {
        resolveRes({ output: Buffer.concat(chunks).toString("utf8"), truncated });
      } else {
        reject(new Error(`git ${op}: ${sanitizeGitStderr(stderr) || `exit ${code ?? "killed"}`}`));
      }
    });
  });
}
