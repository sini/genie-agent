// The tier-1 supervisor (plan C3, design §3): one pi process per thread, driven over pi's RPC
// mode (JSONL commands on stdin, responses and events on stdout), so no two threads share a
// context. It finds or spawns a thread's process and tears it down. Parking and closing on idle
// (C4), escalation (C5), the thread's tier (C7) and the thread state on disk (P2) are not here:
// each enters through `launch` or by calling `teardown`.
import { type ChildProcess, spawn } from "node:child_process";

// How a thread's process starts, e.g. `pi --mode rpc -e <tier-1 extension> --session-dir <store>`.
// C4's resume and P2's per-thread state change the arguments, not the supervisor.
export type Launch = (thread: string) => { command: string; args: string[] };

// A pi RPC record on stdout: a `response` to a command, or a session event.
export type Record = { type: string; id?: string; [key: string]: unknown };

interface Proc {
  child: ChildProcess;
  pending: Map<string, { resolve(r: Record): void; reject(e: Error): void }>;
  exited: Promise<void>;
}

export class Supervisor {
  private procs = new Map<string, Proc>();
  private next = 0;
  private launch: Launch;
  private onEvent: (thread: string, record: Record) => void;

  // onEvent receives every record that answers no command, tagged with its thread.
  constructor(launch: Launch, onEvent: (thread: string, record: Record) => void = () => {}) {
    this.launch = launch;
    this.onEvent = onEvent;
  }

  threads(): string[] {
    return [...this.procs.keys()];
  }

  pid(thread: string): number | undefined {
    return this.procs.get(thread)?.child.pid;
  }

  // Send one command to the thread's process, spawning it first if it has none, and resolve
  // with pi's response. A process that exits before answering rejects.
  command(thread: string, cmd: { type: string; [key: string]: unknown }): Promise<Record> {
    const p = this.procs.get(thread) ?? this.spawn(thread);
    const id = `c${this.next++}`;
    return new Promise((resolve, reject) => {
      p.pending.set(id, { resolve, reject });
      p.child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
    });
  }

  // Close the thread's stdin, pi's orderly shutdown, and kill it if it is still running after
  // graceMs. Other threads' processes are untouched.
  async teardown(thread: string, graceMs = 5_000): Promise<void> {
    const p = this.procs.get(thread);
    if (!p) return;
    this.procs.delete(thread);
    p.child.stdin.end();
    const timer = setTimeout(() => p.child.kill("SIGKILL"), graceMs);
    await p.exited;
    clearTimeout(timer);
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.threads().map((t) => this.teardown(t)));
  }

  private spawn(thread: string): Proc {
    const { command, args } = this.launch(thread);
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    const pending: Proc["pending"] = new Map();
    const exited = new Promise<void>((resolve) => {
      const done = (why: string) => {
        if (this.procs.get(thread)?.child === child) this.procs.delete(thread);
        for (const { reject } of pending.values()) reject(new Error(`thread ${thread}: pi ${why}`));
        pending.clear();
        resolve();
      };
      child.on("error", (err) => done(`failed: ${err.message}`));
      child.on("exit", (code, signal) => done(`exited (${signal ?? code})`));
    });
    // A write to a process that has gone fails here; its exit rejects what was pending.
    child.stdin.on("error", () => {});
    // Split on LF only: readline also splits on U+2028/U+2029, which are valid inside JSON.
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let r: Record;
        try {
          r = JSON.parse(line);
        } catch {
          // stdout is pi's protocol only; a line that is not JSON is passed on, never dropped.
          r = { type: "unparsed", line };
        }
        const waiter = r.type === "response" && r.id !== undefined ? pending.get(r.id) : undefined;
        if (waiter) {
          pending.delete(r.id!);
          waiter.resolve(r);
        } else this.onEvent(thread, r);
      }
    });
    const p = { child, pending, exited };
    this.procs.set(thread, p);
    return p;
  }
}
