// The dispatcher core (design §5.8, D1a): one claude session per escalated thread, launched under a
// minted uuid, resumed under that uuid on demand, and never started fresh once known. Every change
// is journalled before it is acted on, so a restart from the journal resumes what a kill left.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import type { Herdr } from "./herdr.ts";
import { loadJournal, saveJournal, type Journal, type Thread } from "./journal.ts";

export type { Herdr } from "./herdr.ts";
export { loadJournal, saveJournal, type Buffered, type Journal, type Outstanding, type Thread } from "./journal.ts";
export { Delivery, UNAVAILABLE, type DeliveryOptions } from "./delivery.ts";
export { DispatcherGc, type DispatcherGcOptions } from "./gc.ts";
export { SocketXmsg, XmsgError, type Inbound, type XmsgClient, type XmsgSessions } from "./xmsg.ts";
import type { XmsgSessions } from "./xmsg.ts";

export interface TokenRef {
  id: string;
  configDir: string;
}

export interface Options {
  stateDir: string;
  herdr: Herdr;
  xmsg: XmsgSessions;
  // The token a new thread starts on. D4b's pool replaces this stub.
  pickToken: (threadId: string) => TokenRef;
  cwd: string;
  reposDir?: string;
  model?: string;
  now?: () => number;
}

const baseName = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? "";

function isGitRepo(dir: string): boolean {
  try {
    return existsSync(`${dir}/.git`) || (existsSync(`${dir}/HEAD`) && existsSync(`${dir}/objects`));
  } catch {
    return false;
  }
}

export function normalizeRepoName(spec: string): string | null {
  const cleaned = spec
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!cleaned) return null;
  const last = cleaned.split(/[/:]/).pop() ?? "";
  if (!last || last === "." || last === ".." || /[\\/]/.test(last)) return null;
  return last;
}

export class Dispatcher {
  readonly journal: Journal;
  private readonly o: Options;

  private constructor(o: Options, journal: Journal) {
    this.o = o;
    this.journal = journal;
  }

  // Load the journal and reconcile it: a live thread whose pane herdr no longer lists, or whose
  // session xmsg no longer lists, is parked. A pane left without its session is closed, so a
  // resume never runs the same uuid twice.
  static async open(o: Options): Promise<Dispatcher> {
    const d = new Dispatcher(o, loadJournal(o.stateDir));
    const panes = new Set((await o.herdr.list()).map((a) => a.pane));
    const sessions = new Set(await o.xmsg.list());
    for (const t of Object.values(d.journal.threads)) {
      if (t.state !== "live") continue;
      if (t.pane !== null && panes.has(t.pane) && sessions.has(t.session)) continue;
      if (t.pane !== null && panes.has(t.pane)) await o.herdr.close(t.pane);
      t.state = "parked";
      t.pane = null;
    }
    d.save();
    return d;
  }

  save(): void {
    saveJournal(this.o.stateDir, this.journal);
  }

  private modelArgs(): string[] {
    return this.o.model ? ["--model", this.o.model] : [];
  }

  workingCopyDir(threadId: string): string {
    return `${this.o.stateDir}/worktrees/${threadId}`;
  }

  private sourceRoots(): string[] {
    const roots = [
      this.o.reposDir,
      `${this.o.cwd}/source-repos`,
      `${this.o.stateDir}/source-repos`,
      this.o.cwd,
    ];
    return roots.filter((r): r is string => Boolean(r));
  }

  availableSourceRepos(): string[] {
    const names = new Set<string>();
    for (const root of this.sourceRoots()) {
      try {
        if (!existsSync(root)) continue;
        if (isGitRepo(root)) {
          const realName = baseName(realpathSync(root));
          if (realName && realName !== "source-repos") names.add(realName);
          names.add(baseName(root));
          continue;
        }
        for (const entry of readdirSync(root)) {
          if (entry.startsWith(".")) continue;
          const candidate = `${root}/${entry}`;
          if (isGitRepo(candidate)) names.add(entry);
        }
      } catch {}
    }
    return [...names];
  }

  private resolveSourceRepo(repoSpec: string): { name: string; sourcePath: string } | null {
    const name = normalizeRepoName(repoSpec);
    if (!name) return null;
    for (const root of this.sourceRoots()) {
      try {
        const sub = `${root}/${name}`;
        if (isGitRepo(sub)) return { name, sourcePath: sub };
        if (isGitRepo(root)) {
          const realName = baseName(realpathSync(root));
          if (baseName(root) === name || realName === name) {
            return { name, sourcePath: root };
          }
        }
      } catch {}
    }
    return null;
  }

  private prepareWorkingCopy(threadId: string, t: Thread): string {
    const baseDir = this.workingCopyDir(threadId);
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const materialized: string[] = [];
    for (const spec of t.repos ?? []) {
      const resolved = this.resolveSourceRepo(spec);
      if (!resolved) continue;
      const dest = `${baseDir}/${resolved.name}`;
      if (!existsSync(dest)) {
        execFileSync("git", ["clone", "--quiet", "--no-hardlinks", resolved.sourcePath, dest]);
      }
      materialized.push(dest);
    }
    return materialized[0] ?? baseDir;
  }

  removeWorkingCopy(threadId: string): void {
    const baseDir = this.workingCopyDir(threadId);
    if (existsSync(baseDir)) {
      rmSync(baseDir, { recursive: true, force: true });
    }
  }

  // The thread's entry, created parked and unlaunched under a picked token and a minted uuid.
  thread(threadId: string, repos?: string | string[]): Thread {
    const requested = (typeof repos === "string" ? [repos] : repos ?? []).filter((r) => Boolean(r && r.trim()));
    let t = this.journal.threads[threadId];
    if (!t) {
      const token = this.o.pickToken(threadId);
      const session = randomUUID();
      t = {
        session,
        name: `genie-${session.slice(0, 8)}`,
        token: token.id,
        configDir: token.configDir,
        state: "parked",
        pane: null,
        launched: false,
        buffer: [],
        outstanding: [],
        lastReply: null,
        createdAt: this.o.now ? this.o.now() : Date.now(),
        ...(requested.length ? { repos: [...new Set(requested)] } : {}),
        seq: 0,
      };
      this.journal.threads[threadId] = t;
      this.journal.tokens[token.id] ??= { state: "available" };
      // The address is journalled before the process exists.
      this.save();
    } else if (requested.length) {
      const merged = [...new Set([...(t.repos ?? []), ...requested])];
      if (merged.length !== (t.repos?.length ?? 0)) {
        t.repos = merged;
        this.save();
      }
    }
    return t;
  }

  // Bring the thread's session up, launching a new thread under a minted uuid and resuming a
  // parked one under the uuid it was launched with. A live thread is returned as it is.
  async escalate(threadId: string, repos?: string | string[]): Promise<Thread> {
    const t = this.thread(threadId, repos);
    if (t.state === "live") return t;
    const paneCwd = this.prepareWorkingCopy(threadId, t);
    const args = t.launched
      ? ["--resume", t.session, ...this.modelArgs()]
      : ["-n", t.name, "--session-id", t.session, ...this.modelArgs()];
    t.pane = await this.o.herdr.start({ name: t.name, configDir: t.configDir, cwd: paneCwd, args });
    t.state = "live";
    t.launched = true;
    this.save();
    return t;
  }

  // Close the thread's pane; its conversation stays resumable. When to park is D3's.
  async park(threadId: string): Promise<void> {
    const t = this.journal.threads[threadId];
    if (!t || t.state !== "live") return;
    if (t.pane !== null) await this.o.herdr.close(t.pane);
    t.state = "parked";
    t.pane = null;
    this.save();
  }
}
