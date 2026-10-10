// The mirror fetcher (design §6, Git mirror cache): bare mirrors keyed by repository URL, and a
// worktree per thread checked out from them. It is what tier 1's `clone` asks for; tier 1 never
// runs git. Only https:// and git:// URLs are fetched, and never with credentials.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";

export interface MirrorConfig {
  mirrorRoot: string;
  worktreeRoot: string;
}

// A request refused before any git process starts.
export class MirrorRefused extends Error {
  readonly reason: string;
  constructor(reason: string, subject: string) {
    super(`mirror refused ${JSON.stringify(subject)}: ${reason}`);
    this.reason = reason;
  }
}

// Runs git with argv and resolves to its stdout. Tests substitute a spy.
export type Runner = (args: string[]) => Promise<string>;

let emptyHome: string | undefined;

export const git: Runner = (args) => {
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
  return new Promise((resolve, reject) =>
    execFile("git", [...config, ...args], { env }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args.join(" ")}: ${stderr.trim() || err.message}`)) : resolve(stdout),
    ),
  );
};

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

// The fetch into one mirror, and the one place a fetch-size cap or a quota wraps it.
async function fetchMirror(run: Runner, mirrorRoot: string, dir: string, url: string): Promise<void> {
  if (existsSync(dir)) {
    await run(["-C", dir, "fetch", "--prune", "origin"]);
    return;
  }
  // Cloned beside the mirror and renamed into place, so a failed clone leaves no mirror.
  const tmp = mkdtempSync(`${mirrorRoot}/.clone-`);
  try {
    await run(["clone", "--mirror", "--", url, `${tmp}/m`]);
    renameSync(`${tmp}/m`, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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
    await fetchMirror(run, cfg.mirrorRoot, dir, url);
    const rev = (await run(["-C", dir, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (existsSync(path)) {
      await run(["-C", path, "checkout", "--force", "--detach", rev]);
    } else {
      mkdirSync(`${cfg.worktreeRoot}/${thread}`, { recursive: true, mode: 0o755 });
      await run(["-C", dir, "worktree", "add", "--detach", path, rev]);
    }
    return { path, rev };
  });
}
