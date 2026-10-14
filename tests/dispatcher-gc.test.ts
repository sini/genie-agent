// Dispatcher park and GC gating oracle (design oracle 26):
// `pane close` runs under D1b's park predicate; at 96h idle, the transcript goes to the
// archiver (I17) and the entry is dropped, reusing P3's TTL clock.
// Verified with fake clock:
// - never parked with a message outstanding;
// - parked at the threshold after the last reply, and resumable;
// - at 95h kept, at 96h handed off and gone.
// Run with `node --test tests/dispatcher-gc.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  Delivery,
  Dispatcher,
  loadJournal,
  XmsgError,
  type DeliveryOptions,
  type Inbound,
  type Options,
  type XmsgClient,
} from "../src/dispatcher/index.ts";
import type { Herdr, HerdrAgent, StartSpec } from "../src/dispatcher/herdr.ts";
import type { Clock } from "../src/dispatcher/clock.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, p: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; !p(); await sleep(5)) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
  }
};

const H = 60 * 60 * 1000;
const T0 = 1_000_000;

class FakeClock implements Clock {
  t: number;
  private timers = new Map<number, { at: number; f: () => unknown }>();
  private n = 0;

  constructor(t: number) {
    this.t = t;
  }

  now = () => this.t;
  setTimeout = (f: () => unknown, ms: number) => {
    const id = ++this.n;
    this.timers.set(id, { at: this.t + ms, f });
    return id;
  };
  clearTimeout = (id: unknown) => void this.timers.delete(id as number);

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const [id, next] =
        [...this.timers.entries()]
          .filter(([, x]) => x.at <= end)
          .sort(([, a], [, b]) => a.at - b.at)[0] ?? [];
      if (!next) break;
      this.timers.delete(id);
      this.t = next.at;
      await next.f();
    }
    this.t = end;
  }
}

class FakeXmsg implements XmsgClient {
  queue: Inbound[] = [];
  listed = new Set<string>();
  deliveries: { session: string; text: string }[] = [];
  relayed: { id: string; text: string }[] = [];
  answers = new Map<string, string>();
  private keys = new Map<string, string>();

  async poll(): Promise<Inbound | null> {
    return this.queue[0] ?? null;
  }
  async ack(id: string): Promise<void> {
    if (this.queue[0]?.id === id) this.queue.shift();
  }
  async send(session: string, text: string, key: string): Promise<string> {
    if (!this.listed.has(session)) throw new XmsgError("not_found", `session '${session}'`);
    const seen = this.keys.get(key);
    if (seen) return seen;
    this.deliveries.push({ session, text });
    const id = `sent-${this.deliveries.length}`;
    this.keys.set(key, id);
    return id;
  }
  async replies(id: string, waitMs: number): Promise<string[]> {
    for (const end = Date.now() + Math.min(waitMs, 500); Date.now() < end; await sleep(2)) {
      const a = this.answers.get(id);
      if (a !== undefined) return [a];
    }
    return [];
  }
  async reply(id: string, text: string): Promise<void> {
    this.relayed.push({ id, text });
  }
  async list(): Promise<string[]> {
    return [...this.listed];
  }
  answer(n: number, text: string): void {
    this.answers.set(`sent-${n}`, text);
  }
}

class FakeHerdr implements Herdr {
  starts: StartSpec[] = [];
  closes: string[] = [];
  panes = new Map<string, string>();
  private next = 2;
  private readonly x: FakeXmsg;

  constructor(x: FakeXmsg) {
    this.x = x;
  }

  async start(spec: StartSpec): Promise<string> {
    this.starts.push(spec);
    const pane = `w1:p${this.next++}`;
    const at = spec.args.findIndex((a) => a === "--session-id" || a === "--resume");
    const session = spec.args[at + 1];
    this.panes.set(pane, session);
    this.x.listed.add(session);
    return pane;
  }
  async close(pane: string): Promise<void> {
    this.closes.push(pane);
    const session = this.panes.get(pane);
    if (session) this.x.listed.delete(session);
    this.panes.delete(pane);
  }
  async list(): Promise<HerdrAgent[]> {
    return [...this.panes.keys()].map((pane) => ({ pane }));
  }
}

const setup = (extra: Partial<DeliveryOptions> = {}) => {
  const clock = new FakeClock(T0);
  const x = new FakeXmsg();
  const herdr = new FakeHerdr(x);
  const root = mkdtempSync(`${tmpdir()}/d3-test-`);
  const stateDir = `${root}/state`;
  const tokenDir = `${root}/token-a`;
  mkdirSync(tokenDir, { recursive: true });
  const archived = new Map<string, string>();
  const o: Options = {
    stateDir,
    herdr,
    xmsg: x,
    pickToken: () => ({ id: "tok-a", configDir: tokenDir }),
    cwd: "/cwd",
    now: () => clock.now(),
  };
  const live: Delivery[] = [];
  let failArchive = false;
  const boot = async (deliveryExtra: Partial<DeliveryOptions> = {}) => {
    const d = await Dispatcher.open(o);
    const del = new Delivery(d, x, {
      threadOf: (m: Inbound) => m.text.split(":")[0],
      clock,
      readyPollMs: 5,
      replyTimeoutMs: 1500,
      idleMs: 1 * H,
      sweepMs: 1 * H,
      archive: async (th, sess) => {
        if (failArchive) throw new Error("archive storage unavailable");
        archived.set(th, sess);
      },
      ...extra,
      ...deliveryExtra,
    });
    del.start();
    live.push(del);
    return { d, del };
  };
  const msg = (id: string, text: string) => x.queue.push({ id, text });
  return {
    clock,
    x,
    herdr,
    o,
    stateDir,
    tokenDir,
    archived,
    setFailArchive: (v: boolean) => {
      failArchive = v;
    },
    boot,
    msg,
    stop: () => live.forEach((d) => d.stop()),
  };
};

const cell = (name: string, body: (s: ReturnType<typeof setup>) => Promise<void>) =>
  test(name, async () => {
    const s = setup();
    try {
      await body(s);
    } finally {
      s.stop();
    }
  });

// A thread that has completed one turn and whose lastReply is T0.
const answeredTurn = async (s: ReturnType<typeof setup>) => {
  const { d, del } = await s.boot();
  s.x.answer(1, "a1");
  s.msg("m1", "t:first");
  await del.pump(0);
  await until("first reply", () => s.x.relayed.length === 1);
  return { d, del, session: d.journal.threads.t.session };
};

cell("oracle 26: never parked with a message outstanding or in buffer", async (s) => {
  const { d, del } = await s.boot();
  s.msg("m1", "t:first");
  await del.pump(0);
  await until("first delivery", () => s.x.deliveries.length === 1);

  // Message m1 has been delivered to session and is awaiting reply (outstanding)
  assert.equal(d.journal.threads.t.outstanding.length, 1);
  assert.equal(d.journal.threads.t.state, "live");

  // Advance time past the 1h idle threshold with a message outstanding
  await s.clock.advance(5 * H);
  assert.equal(del.parkable("t"), false, "never parkable with message outstanding");
  assert.equal(d.journal.threads.t.state, "live", "thread must not be parked");
  assert.equal(s.herdr.closes.length, 0, "herdr pane must not be closed");

  // Add a buffered message m2
  d.journal.threads.t.buffer.push({ id: "m2", body: "t:second", key: "m2#2" });
  assert.equal(d.journal.threads.t.buffer.length, 1);

  // Advance time further
  await s.clock.advance(5 * H);
  assert.equal(del.parkable("t"), false, "never parkable with message buffered");
  assert.equal(d.journal.threads.t.state, "live");
  assert.equal(s.herdr.closes.length, 0);

  // Clear buffer and answer m1
  d.journal.threads.t.buffer.pop();
  s.x.answer(1, "a1");
  await until("first reply", () => s.x.relayed.length === 1);
  assert.equal(d.journal.threads.t.outstanding.length, 0);
  assert.equal(d.journal.threads.t.buffer.length, 0);
});

cell("oracle 26: parked at the threshold after the last reply, and resumable", async (s) => {
  const { d, del, session } = await answeredTurn(s);
  assert.equal(d.journal.threads.t.state, "live");
  assert.equal(s.herdr.closes.length, 0);

  // At 30 minutes after last reply: threshold (1h) has not elapsed
  await s.clock.advance(30 * 60 * 1000);
  assert.equal(d.journal.threads.t.state, "live", "must not park before threshold");
  assert.equal(s.herdr.closes.length, 0);

  // At 60 minutes after last reply (threshold elapsed): parks pane and marks parked
  await s.clock.advance(30 * 60 * 1000);
  assert.equal(d.journal.threads.t.state, "parked", "must park at threshold");
  assert.equal(d.journal.threads.t.pane, null);
  assert.equal(s.herdr.closes.length, 1, "herdr close was called");

  // Resumable: a new message to the parked thread resumes the session
  s.msg("m2", "t:second");
  await del.pump(0);
  await until("delivery after resume", () => s.x.deliveries.length === 2);
  assert.equal(s.herdr.starts.length, 2);
  assert.deepEqual(s.herdr.starts[1].args, ["--resume", session]);
  s.x.answer(2, "a2");
  await until("reply after resume", () => s.x.relayed.length === 2);
  assert.equal(s.x.relayed[1].text, "a2");
});

cell("oracle 26: at 95h idle kept, at 96h handed off and gone", async (s) => {
  const { d, session } = await answeredTurn(s);

  // Advance 1h: parked
  await s.clock.advance(1 * H);
  assert.equal(d.journal.threads.t.state, "parked");
  assert.equal(s.archived.size, 0);

  // Advance to 95h total idle after last reply
  await s.clock.advance(94 * H);
  assert.equal(s.archived.has("t"), false, "not archived at 95h idle");
  assert.notEqual(d.journal.threads.t, undefined, "entry kept in memory at 95h idle");
  assert.notEqual(loadJournal(s.stateDir).threads.t, undefined, "entry kept on disk at 95h idle");

  // Advance to 96h total idle after last reply
  await s.clock.advance(1 * H);
  assert.equal(s.archived.has("t"), true, "handed off to archiver at 96h idle");
  assert.equal(s.archived.get("t"), session, "archiver received thread session uuid");
  assert.equal(d.journal.threads.t, undefined, "entry dropped from memory at 96h idle");
  assert.equal(loadJournal(s.stateDir).threads.t, undefined, "entry dropped from journal on disk at 96h idle");
});

cell("a thread GC'd at 96h starts fresh from its package on a later escalation", async (s) => {
  const { d, del, session: oldSession } = await answeredTurn(s);

  // Advance past 96h idle: GC hands off and drops entry
  await s.clock.advance(96 * H);
  assert.equal(d.journal.threads.t, undefined);

  // Later escalation of that thread arrives
  s.msg("m_new", "t:fresh_start");
  await del.pump(0);
  await until("delivery for fresh thread", () => s.x.deliveries.length === 2);

  // Starts fresh under a new uuid, not --resume
  const newThread = d.journal.threads.t;
  assert.notEqual(newThread, undefined);
  assert.notEqual(newThread.session, oldSession, "must mint fresh session uuid");
  const lastStart = s.herdr.starts[s.herdr.starts.length - 1];
  assert.ok(lastStart.args.includes("--session-id"), "launched fresh with --session-id");
  assert.ok(!lastStart.args.includes("--resume"), "did not resume expired session");
});

cell("a failed archive deletes nothing from journal, and the next sweep retries it", async (s) => {
  const { d } = await answeredTurn(s);
  s.setFailArchive(true);

  // Advance to 96h idle while archiver is failing
  await s.clock.advance(96 * H);
  assert.notEqual(d.journal.threads.t, undefined, "entry must not be deleted on archive failure");
  assert.notEqual(loadJournal(s.stateDir).threads.t, undefined, "disk journal must keep entry");

  // Archiver recovers; next sweep collects it
  s.setFailArchive(false);
  await s.clock.advance(1 * H);
  assert.equal(s.archived.has("t"), true);
  assert.equal(d.journal.threads.t, undefined, "collected on retry");
  assert.equal(loadJournal(s.stateDir).threads.t, undefined);
});

cell("transcript file in configDir is removed on collection", async (s) => {
  const { d, session } = await answeredTurn(s);
  const transcriptsDir = `${s.tokenDir}/transcripts`;
  mkdirSync(transcriptsDir, { recursive: true });
  const transcriptPath = `${transcriptsDir}/${session}.jsonl`;
  writeFileSync(transcriptPath, '{"role":"user","content":"hello"}\n');
  assert.ok(existsSync(transcriptPath));

  // Advance past 96h
  await s.clock.advance(96 * H);
  assert.equal(d.journal.threads.t, undefined);
  assert.equal(existsSync(transcriptPath), false, "transcript file must leave the tier's home");
});
