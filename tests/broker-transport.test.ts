import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { SocketXmsg } from "../src/dispatcher/xmsg.ts";
import { XmsgIo } from "../src/root/io.ts";

test("broker transport: retains registration limits and sends keyed replies on existing service frame", async () => {
  const directory = mkdtempSync(`${tmpdir()}/genie-bridge-wire-`); const frames: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let i; (i = buffer.indexOf("\n")) >= 0;) {
        const frame = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); frames.push(frame);
        socket.write(JSON.stringify(frame.harness ? { status: "ok", address: "genie@node", node: "node", max_body_bytes: 4096, reply_ttl_secs: 45, idempotency_ttl_secs: 90 } : { status: "ok", messageId: "reply" }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(`${directory}/register.sock`, resolve));
  const client = new SocketXmsg(directory, "genie");
  try {
    await client.register();
    assert.deepEqual(client.registrationLimits, { max_body_bytes: 4096, reply_ttl_secs: 45, idempotency_ttl_secs: 90 });
    await client.reply("original", "{}", "stable-key");
    assert.deepEqual(frames[1], { action: "reply", messageId: "original", text: "{}", idempotency_key: "stable-key" });
    await client.reply("legacy", "{}"); assert.equal(Object.hasOwn(frames[2], "idempotency_key"), false);
  } finally { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("broker transport: durable accept precedes ACK and acknowledgement confirmation follows ACK", async () => {
  const order: string[] = []; let delivered = false;
  const message = { id: "original", text: "{}", origin: { service: "gateway", node: "edge" } };
  const client = {
    register: async () => ({}), close: () => {}, list: async () => [], send: async () => "sent", reply: async () => "reply", replies: async () => [],
    poll: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); if (delivered) return null; delivered = true; return message; },
    ack: async () => { order.push("ack"); },
  };
  const io = new XmsgIo({ guardEnable: false }, client);
  io.setBrokerHandler(async (actual) => { assert.deepEqual(actual, message); order.push("durable-accept"); return true; }, async (actual) => { assert.deepEqual(actual, message); order.push("ack-confirmed"); });
  try {
    await io.register(false); assert.deepEqual(order, [], "registration polled before handler installation"); io.resume();
    const end = Date.now() + 1000;
    while (order.length < 3 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(order, ["durable-accept", "ack", "ack-confirmed"]);
  } finally { io.close(); }
});

test("broker transport: bounded queue backpressure times out guard safely and resumes FIFO custody", async () => {
  const { BrokerBridge } = await import("../src/broker/bridge.ts");
  const directory = mkdtempSync(`${tmpdir()}/genie-bridge-pressure-`);
  const principal = { service: "gateway", node: "edge" };
  const inbox: any[] = []; let active: any = null;
  const acknowledged: string[] = []; const results: any[] = []; const acted: string[] = [];
  let sends = 0; let deferred = 0;
  let releaseFirstSend!: () => void;
  const capacityForced = new Promise<void>((resolve) => { releaseFirstSend = resolve; });
  const client = {
    register: async () => ({}), close: () => {}, list: async () => [], replies: async () => [],
    poll: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); active ??= inbox.shift() ?? null; return active; },
    ack: async (id: string) => { acknowledged.push(id); if (active?.id === id) active = null; },
    reply: async (_id: string, text: string) => { results.push(JSON.parse(text)); return "reply"; },
    send: async () => {
      const id = `guard-${++sends}`;
      if (sends === 1) await capacityForced;
      if (sends > 1) inbox.push({ id: `verdict-${sends}`, inReplyTo: id, text: JSON.stringify({ verdict: "allow", reason: "reviewed", cleaned_text: "reviewed" }) });
      return id;
    },
  };
  const io = new XmsgIo({ guard: { target: "guard", timeoutMs: 100 }, guardEnable: true, log: () => { deferred++; releaseFirstSend(); } }, client);
  const bridge = new BrokerBridge({ stateRoot: directory, allowlist: [principal], maxBodyBytes: 4096, maxQueued: 1, maxRecords: 10,
    propose: async (_principal, proposal) => {
      const reviewed = await io.guard!.check({ source: "web", content: { text: proposal.body ?? "" } } as any);
      if ("unavailable" in reviewed || reviewed.verdict !== "allow") return { thread: "fixture", acted: false, reason: "review unavailable", redactions: [] };
      acted.push(proposal.body!); return { thread: "fixture", acted: true, reason: "reviewed", redactions: [] };
    }, reply: (id, text, key) => io.brokerReply(id, text, key) });
  io.setBrokerHandler((message) => bridge.accept({ ...message, origin: message.origin }), (message) => bridge.acknowledge({ ...message, origin: message.origin }));
  const put = (id: string) => inbox.push({ id, origin: principal, text: `[External message via gateway@edge; gateway correlation gw-${"a".repeat(64)}]\n${JSON.stringify({ kind: "gist_comment", id: "abc", body: id })}` });
  const until = async (predicate: () => boolean) => { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error("queue recovery timed out"); await new Promise((resolve) => setTimeout(resolve, 2)); } };
  try {
    await bridge.start(); await io.register(); put("first"); await until(() => sends === 1);
    put("second"); put("third");
    inbox.push({ id: "late-first-verdict", inReplyTo: "guard-1", text: JSON.stringify({ verdict: "allow", reason: "late review", cleaned_text: "reviewed" }) });
    await until(() => results.length === 3);
    assert.ok(deferred > 0, "control did not force queue saturation");
    assert.equal(results.filter((result) => result.acted === false).length, 1);
    assert.deepEqual(acted, ["second", "third"], "timed-out review permitted an Act");
    assert.ok(acknowledged.includes("third")); assert.ok(acknowledged.includes("late-first-verdict"));
  } finally { await bridge.close(); io.close(); rmSync(directory, { recursive: true, force: true }); }
});
