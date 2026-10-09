// The dispatcher core (design §5.8, D1a): one claude session per escalated thread, launched under a
// minted uuid, resumed under that uuid on demand, and never started fresh once known. Every change
// is journalled before it is acted on, so a restart from the journal resumes what a kill left.
import { randomUUID } from "node:crypto";
import type { Herdr } from "./herdr.ts";
import { loadJournal, saveJournal, type Journal, type Thread } from "./journal.ts";

export type { Herdr } from "./herdr.ts";
export type { Buffered, Journal, Outstanding, Thread } from "./journal.ts";
export { Delivery, UNAVAILABLE, type DeliveryOptions } from "./delivery.ts";
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
  model?: string;
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

  // The thread's entry, created parked and unlaunched under a picked token and a minted uuid.
  thread(threadId: string): Thread {
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
        seq: 0,
      };
      this.journal.threads[threadId] = t;
      this.journal.tokens[token.id] ??= { state: "available" };
      // The address is journalled before the process exists.
      this.save();
    }
    return t;
  }

  // Bring the thread's session up, launching a new thread under a minted uuid and resuming a
  // parked one under the uuid it was launched with. A live thread is returned as it is.
  async escalate(threadId: string): Promise<Thread> {
    const t = this.thread(threadId);
    if (t.state === "live") return t;
    const args = t.launched
      ? ["--resume", t.session, ...this.modelArgs()]
      : ["-n", t.name, "--session-id", t.session, ...this.modelArgs()];
    t.pane = await this.o.herdr.start({ name: t.name, configDir: t.configDir, cwd: this.o.cwd, args });
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
