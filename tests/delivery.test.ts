// Dispatcher delivery's gating oracle (design oracle 28), against an xmsg fake with X9's
// at-least-once queue and X10's idempotency keys, and a herdr fake whose session xmsg lists only
// after a delay. Run with `node --test tests/delivery.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import {
  Delivery,
  Dispatcher,
  SocketXmsg,
  UNAVAILABLE,
  XmsgError,
  type DeliveryOptions,
  type Inbound,
  type Options,
  type XmsgClient,
} from "../src/dispatcher/index.ts";
import type { Herdr, HerdrAgent, StartSpec } from "../src/dispatcher/herdr.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, p: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; !p(); await sleep(5)) if (Date.now() > end) assert.fail(`timed out: ${what}`);
};

class FakeXmsg implements XmsgClient {
  queue: Inbound[] = [];
  listed = new Set<string>();
  deliveries: { session: string; text: string }[] = [];
  relayed: { id: string; text: string }[] = [];
  answers = new Map<string, string>();
  // The next n sends deliver and then lose their response.
  lose = 0;
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
    if (this.lose-- > 0) throw new Error("response lost");
    return id;
  }
  async replies(id: string, waitMs: number): Promise<string[]> {
    for (const end = Date.now() + waitMs; Date.now() < end; await sleep(2)) {
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
  // The session answers its n-th delivery.
  answer(n: number, text: string): void {
    this.answers.set(`sent-${n}`, text);
  }
}

// A herdr server whose sessions xmsg lists `readyMs` after the start returns.
class FakeHerdr implements Herdr {
  starts: StartSpec[] = [];
  closes: string[] = [];
  panes = new Map<string, string>();
  readyMs = 0;
  hold: Promise<void> | null = null;
  private next = 2;
  private readonly x: FakeXmsg;
  constructor(x: FakeXmsg) {
    this.x = x;
  }

  async start(spec: StartSpec): Promise<string> {
    this.starts.push(spec);
    if (this.hold) await this.hold;
    const pane = `w1:p${this.next++}`;
    const session = spec.args[spec.args.findIndex((a) => a === "--session-id" || a === "--resume") + 1];
    this.panes.set(pane, session);
    setTimeout(() => this.x.listed.add(session), this.readyMs);
    return pane;
  }
  async close(pane: string): Promise<void> {
    this.closes.push(pane);
    this.x.listed.delete(this.panes.get(pane)!);
    this.panes.delete(pane);
  }
  async list(): Promise<HerdrAgent[]> {
    return [...this.panes.keys()].map((pane) => ({ pane }));
  }
}

const setup = () => {
  const x = new FakeXmsg();
  const herdr = new FakeHerdr(x);
  const o: Options = {
    stateDir: `${mkdtempSync(`${tmpdir()}/d1b-`)}/state`,
    herdr,
    xmsg: x,
    pickToken: () => ({ id: "tok-a", configDir: "/cfg/tok-a" }),
    cwd: "/cwd",
  };
  const live: Delivery[] = [];
  let clock = 1_000_000;
  const tick = (ms: number) => (clock += ms);
  // `packages` boots the production thread key, the package's thread_id; otherwise a message
  // `<thread>:<body>` names its thread.
  const boot = async (extra: DeliveryOptions = {}, packages = false) => {
    const d = await Dispatcher.open(o);
    const threadOf = packages ? {} : { threadOf: (m: Inbound) => m.text.split(":")[0] };
    const del = new Delivery(d, x, { ...threadOf, readyPollMs: 5, replyTimeoutMs: 1500, ...extra });
    del.start();
    live.push(del);
    return { d, del };
  };
  // Receive one supervisor message `<thread>:<body>`.
  const msg = (id: string, text: string) => x.queue.push({ id, text });
  return { x, herdr, o, boot, msg, tick, now: () => clock, stop: () => live.forEach((d) => d.stop()) };
};

// Every cell stops its dispatchers, so a red cell fails rather than hanging the run.
const cell = (name: string, body: (s: ReturnType<typeof setup>) => Promise<void>) =>
  test(name, async () => {
    const s = setup();
    try {
      await body(s);
    } finally {
      s.stop();
    }
  });

// A thread that has had one turn answered and is parked.
const parkedThread = async (s: ReturnType<typeof setup>) => {
  const { d, del } = await s.boot();
  s.msg("m0", "t:first");
  await del.pump(0);
  await until("first delivery", () => s.x.deliveries.length === 1);
  s.x.answer(1, "a0");
  await until("first reply", () => s.x.relayed.length === 1);
  await d.park("t");
  del.stop();
};

cell("oracle 28: a message to a parked thread is buffered, delivered once xmsg lists the resumed uuid, and answered", async (s) => {
  await parkedThread(s);
  s.herdr.readyMs = 60;
  const { d, del } = await s.boot();
  s.msg("m1", "t:second");
  await del.pump(0);
  await until("delivery after resume", () => s.x.deliveries.length === 2);
  assert.equal(s.herdr.starts.length, 2);
  assert.deepEqual(s.herdr.starts[1].args, ["--resume", d.journal.threads.t.session]);
  s.x.answer(2, "a1");
  await until("reply", () => s.x.relayed.length === 2);
  assert.deepEqual(s.x.relayed[1], { id: "m1", text: "a1" });
});

cell("a send that finds the session gone parks the thread, resumes it and delivers", async (s) => {
  const { d, del } = await s.boot();
  await d.escalate("t");
  await until("listed", () => s.x.listed.size === 1);
  s.x.listed.clear(); // the session died; the journal still says live
  s.msg("m1", "t:hello");
  await del.pump(0);
  await until("delivery", () => s.x.deliveries.length === 1);
  assert.equal(s.herdr.closes.length, 1);
  assert.deepEqual(s.herdr.starts[1].args, ["--resume", d.journal.threads.t.session]);
});

cell("two buffered messages and one arriving during the resume are delivered in order", async (s) => {
  await parkedThread(s);
  let release!: () => void;
  s.herdr.hold = new Promise((r) => (release = r));
  const { del } = await s.boot();
  for (const id of ["m1", "m2"]) {
    s.msg(id, `t:${id}`);
    await del.pump(0);
  }
  await until("resume started", () => s.herdr.starts.length === 2);
  s.msg("m3", "t:m3");
  await del.pump(0);
  release();
  await until("three deliveries", () => s.x.deliveries.length === 4);
  assert.deepEqual(s.x.deliveries.slice(1).map((m) => m.text), ["t:m1", "t:m2", "t:m3"]);
});

cell("a send within 1 s of a reply is never lost to a park", async (s) => {
  const { del } = await s.boot({ now: s.now, idleMs: 1000, replyTimeoutMs: 60_000 });
  s.msg("m1", "t:one");
  await del.pump(0);
  await until("delivery", () => s.x.deliveries.length === 1);
  s.x.answer(1, "a1");
  await until("reply", () => s.x.relayed.length === 1);
  s.tick(500);
  assert.equal(del.parkable("t"), false, "parkable 500 ms after a reply");
  s.msg("m2", "t:two");
  await del.pump(0);
  await until("second delivery", () => s.x.deliveries.length === 2);
  s.tick(5000);
  assert.equal(del.parkable("t"), false, "parkable with a message outstanding");
  s.x.answer(2, "a2");
  await until("second reply", () => s.x.relayed.length === 2);
  assert.equal(del.parkable("t"), false, "parkable at the reply");
  s.tick(1000);
  assert.equal(del.parkable("t"), true, "not parkable at the idle threshold");
});

cell("a live thread is parkable one hour after its last reply and not before", async (s) => {
  const { del } = await s.boot({ now: s.now });
  s.msg("m1", "t:one");
  await del.pump(0);
  await until("delivery", () => s.x.deliveries.length === 1);
  s.x.answer(1, "a1");
  await until("reply", () => s.x.relayed.length === 1);
  s.tick(59 * 60_000);
  assert.equal(del.parkable("t"), false, "parkable at 59 min");
  s.tick(60_000);
  assert.equal(del.parkable("t"), true, "not parkable at 60 min");
});

cell("a retried send with the same key yields one turn", async (s) => {
  const { del } = await s.boot();
  s.x.lose = 1;
  s.msg("m1", "t:once");
  await del.pump(0);
  await until("delivery", () => s.x.deliveries.length >= 1);
  s.x.answer(1, "a1");
  await until("reply", () => s.x.relayed.length === 1);
  await del.settled();
  assert.equal(s.x.deliveries.length, 1);
  assert.deepEqual(s.x.relayed, [{ id: "m1", text: "a1" }]);
});

cell("restart: a dispatcher killed between a send and its reply still relays the reply", async (s) => {
  const first = await s.boot();
  s.msg("m1", "t:q");
  await first.del.pump(0);
  await until("delivery", () => s.x.deliveries.length === 1);
  first.del.stop(); // the kill
  const { del } = await s.boot();
  s.x.answer(1, "a1");
  await until("relay after restart", () => s.x.relayed.length === 1);
  assert.deepEqual(s.x.relayed, [{ id: "m1", text: "a1" }]);
});

cell("a buffered message survives a kill before its delivery", async (s) => {
  await parkedThread(s);
  s.herdr.hold = new Promise(() => {}); // the resume never returns before the kill
  const first = await s.boot();
  s.msg("m1", "t:held");
  await first.del.pump(0);
  first.del.stop();
  s.herdr.hold = null;
  const { del } = await s.boot();
  await until("delivery after restart", () => s.x.deliveries.length === 2);
  assert.equal(s.x.deliveries[1].text, "t:held");
});

cell("a message is acknowledged only after its journal write", async (s) => {
  const first = await s.boot();
  first.del.stop();
  s.msg("m1", "t:keep");
  chmodSync(s.o.stateDir, 0o500); // the journal write fails: a crash before the ack
  await assert.rejects(first.del.pump(0));
  chmodSync(s.o.stateDir, 0o700);
  const { del } = await s.boot();
  assert.equal(await del.pump(0), true, "the message was not redelivered");
  await until("delivery", () => s.x.deliveries.length === 1);
});

cell("a turn with no reply within the timeout ends expert unavailable, and a late reply is dropped", async (s) => {
  const { del } = await s.boot({ replyTimeoutMs: 50 });
  s.msg("m1", "t:slow");
  await del.pump(0);
  await until("timeout", () => s.x.relayed.length === 1);
  assert.deepEqual(s.x.relayed, [{ id: "m1", text: UNAVAILABLE }]);
  s.x.answer(1, "late");
  await sleep(100);
  assert.equal(s.x.relayed.length, 1);
});

const pkg = (thread_id: string, q: string) => JSON.stringify({ thread_id, cleaned_question: q });

cell("two packages with one thread_id reach one session, and another thread_id a second", async (s) => {
  const { d, del } = await s.boot({}, true);
  for (const [id, t] of [["m1", "$a"], ["m2", "$a"], ["m3", "$b"]]) {
    s.msg(id, pkg(t, id));
    await del.pump(0);
  }
  await until("three deliveries", () => s.x.deliveries.length === 3);
  assert.deepEqual(Object.keys(d.journal.threads).sort(), ["$a", "$b"]);
  assert.equal(s.herdr.starts.length, 2);
  const [a1, a2, b] = s.x.deliveries.map((m) => m.session);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

cell("a message that is not a package is answered expert unavailable, acknowledged, and makes no thread", async (s) => {
  const { del } = await s.boot({}, true);
  const bad = ["not json", "null", JSON.stringify({ cleaned_question: "q" }), pkg("", "q"), JSON.stringify({ thread_id: 5 })];
  for (const [i, text] of bad.entries()) {
    s.msg(`m${i}`, text);
    assert.equal(await del.pump(0), true);
  }
  assert.deepEqual(s.x.queue, [], "every message acknowledged");
  assert.deepEqual(s.x.relayed, bad.map((_, i) => ({ id: `m${i}`, text: UNAVAILABLE })));
  assert.equal(s.herdr.starts.length, 0);
  assert.deepEqual((await Dispatcher.open(s.o)).journal.threads, {}, "nothing journalled");
});

// The real client, by its frames, against a socket server per xmsg socket.
test("the socket client speaks X9 on register.sock, attested sends on agent.sock and http.sock reads", async () => {
  const dir = mkdtempSync(`${tmpdir()}/xm-`);
  const frames: any[] = [];
  const lines = (answer: (f: any) => object) => (c: any) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      for (buf += d; buf.includes("\n"); buf = buf.slice(buf.indexOf("\n") + 1)) {
        const f = JSON.parse(buf.slice(0, buf.indexOf("\n")));
        frames.push(f);
        c.write(`${JSON.stringify(answer(f))}\n`);
      }
    });
  };
  const reg = netServer(lines((f) =>
    f.harness ? { status: "ok", sessionId: "svc:genie-expert" }
    : f.action === "poll" ? { action: "deliver", messageId: "01A", text: "t:hi", fromName: "x", envelope: "e" }
    : { status: "ok" }));
  const agent = netServer(lines((f) =>
    f.ref === "gone" ? { status: "error", error: "not_found", detail: "session 'gone'" }
    : f.action === "send" ? { status: "ok", delivery: { messageId: "01B" } }
    : { status: "ok", reply: {} }));
  const http = httpServer((req: any, res: any) => {
    frames.push(req.url);
    res.end(JSON.stringify(req.url === "/v1/sessions" ? [{ sessionId: "u-1" }] : [{ seq: 1, text: "r" }]));
  });
  await Promise.all([[reg, "register"], [agent, "agent"], [http, "http"]].map(
    ([s, n]: any) => new Promise((r) => s.listen(`${dir}/${n}.sock`, r))));
  const c = new SocketXmsg(dir, "genie-expert");
  try {
    await c.register();
    assert.deepEqual(await c.poll(30_000), { id: "01A", text: "t:hi" });
    await c.ack("01A");
    assert.equal(await c.send("u-1", "body", "01A#1"), "01B");
    await assert.rejects(c.send("gone", "body", "k"), (e: any) => e instanceof XmsgError && e.code === "not_found");
    await c.reply("01A", "answer");
    assert.deepEqual(await c.list(), ["u-1"]);
    assert.deepEqual(await c.replies("01B", 1500), ["r"]);
    assert.deepEqual(frames, [
      { harness: "svc", name: "genie-expert" },
      { action: "poll", waitSecs: 30 },
      { action: "ack", messageId: "01A" },
      { action: "send", ref: "u-1", text: "body", push_replies: false, idempotency_key: "01A#1" },
      { action: "send", ref: "gone", text: "body", push_replies: false, idempotency_key: "k" },
      { action: "reply", messageId: "01A", text: "answer" },
      "/v1/sessions",
      "/v1/messages/01B/replies?wait=2",
    ]);
  } finally {
    c.close();
    for (const s of [reg, agent, http]) s.close();
  }
});
