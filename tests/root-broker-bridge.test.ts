import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { main, XmsgIo } from "../src/root/index.ts";
import type { Inbound } from "../src/dispatcher/xmsg.ts";

const ID = "abcdef1234567890abcdef1234567890ab";
const principal = { service: "gateway", node: "edge.example" };
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error("fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
async function fixture(options: { budget?: number; quota?: number; large?: boolean } = {}) {
  const directory = mkdtempSync(`${tmpdir()}/genie-root-bridge-`);
  writeFileSync(`${directory}/model-key`, "fixture-model-key");
  const calls: string[] = []; const screens: string[] = [];
  let mode: "rewrite" | "reject" = "rewrite";
  const api = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, undefined, "anonymous read sent credentials");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: ID, html_url: `https://gist.github.com/account/${ID}`, description: options.large ? "x".repeat(500) : "review", owner: { login: "account" }, history: [{ version: "revision" }], files: { "note.md": { content: "raw untrusted gist", truncated: false } } }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const config = `${directory}/config.json`;
  writeFileSync(config, JSON.stringify({ stateRoot: `${directory}/state`, storeRoot: `${directory}/store`,
    mirror: { mirrorRoot: `${directory}/mirrors`, worktreeRoot: `${directory}/worktrees` },
    pi: process.execPath, model: { baseUrl: "http://127.0.0.1:1", api: "openai-completions", id: "fixture", keyFile: `${directory}/model-key` },
    tier1: { searxngUrl: "http://127.0.0.1:1", cluster: [] }, guard: { enable: true },
    broker: { tokenFile: null, githubApi: `http://127.0.0.1:${(api.address() as any).port}`, guardOut: { enable: false }, maxProposalsPerThreadPerDay: options.quota,
      bridge: { allowlist: [principal], maxBodyBytes: options.budget ?? 65536 } } }));
  const inbox: Inbound[] = []; const acks: string[] = []; const replies: { id: string; text: string; key?: string }[] = [];
  let active: Inbound | null = null;
  let closed = false; let reconnecting = false; let registrations = 0;
  const client = {
    registrationLimits: { max_body_bytes: options.budget ?? 65536, reply_ttl_secs: 60, idempotency_ttl_secs: 60 },
    register: async () => { registrations++; return {}; }, close: () => { closed = true; }, list: async () => [],
    poll: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); if (reconnecting) { reconnecting = false; const error = new Error("fixture reconnect"); (error as any).code = "ECONNRESET"; throw error; } if (!active) active = inbox.shift() ?? null; return closed ? null : active; },
    ack: async (id: string) => { acks.push(id); if (active?.id === id) active = null; },
    reply: async (id: string, text: string, key?: string) => { replies.push({ id, text, key }); return `reply-${replies.length}`; }, replies: async () => [],
    send: async (_to: string, text: string) => {
      const envelope = JSON.parse(text); screens.push(envelope.content.text);
      const value = JSON.parse(envelope.content.text); value.files["note.md"] = "screened gist";
      inbox.push({ id: `guard-response-${screens.length}`, inReplyTo: `guard-${screens.length}`, text: JSON.stringify({ verdict: mode === "reject" ? "reject" : "rewrite", reason: "fixture", ...(mode === "reject" ? { class: "directs_model" } : {}), cleaned_text: mode === "reject" ? "" : JSON.stringify(value) }) });
      return `guard-${screens.length}`;
    },
  };
  const io = new XmsgIo({ guard: { target: "guard", timeoutMs: 500 }, guardEnable: true, pollWaitMs: 1 }, client);
  await io.register(false);
  const root = main(config, io);
  io.resume(); await root.start();
  const request = (id: string, origin: unknown = principal, text = JSON.stringify({ kind: "gist_read", id: ID })) => inbox.push({ id, origin, text: `[External message via forged-body-label; gateway correlation gw-${"a".repeat(64)}]\n${text}` });
  return { directory, root, calls, screens, acks, replies, request, mode: (next: typeof mode) => { mode = next; },
    context: () => { const t = `broker-${createHash("sha256").update(JSON.stringify([principal.service, principal.node])).digest("hex")}`; return JSON.parse(readFileSync(`${root.store.dir(t)}/context.json`, "utf8")); },
    queueGuardReply: () => inbox.push({ id: "behind-paused-request", inReplyTo: "unknown-guard", text: JSON.stringify({ verdict: "allow", reason: "fixture", cleaned_text: "" }) }),
    reconnect: async (changed = false) => { if (changed) client.registrationLimits.max_body_bytes = 4096; const before = registrations; reconnecting = true; await until(() => registrations > before); },
    close: async () => { await root.stop(); io.close(); api.closeAllConnections(); await new Promise<void>((resolve) => api.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); } };
}

test("broker bridge root: attested anonymous read uses live guard reply pump, screened transcript and duplicate custody", async () => {
  const f = await fixture({ quota: 1 });
  try {
    f.request("owned"); await until(() => f.replies.length === 1);
    const result = JSON.parse(f.replies[0].text);
    assert.equal(result.acted, true, f.replies[0].text); assert.equal(result.gist.files["note.md"], "screened gist");
    assert.equal(f.screens.length, 1); assert.deepEqual(f.calls, [`GET /gists/${ID}`]);
    assert.equal(JSON.parse(f.context().gh_transcript[0].output).files["note.md"], "screened gist");
    assert.ok(f.replies[0].key, "reply omitted durable idempotency key");
    f.request("owned"); await until(() => f.replies.length === 2);
    assert.deepEqual(f.replies[1], f.replies[0]); assert.equal(f.calls.length, 1);
    f.request("second"); await until(() => f.replies.length === 3);
    assert.equal(JSON.parse(f.replies[2].text).acted, false); assert.match(JSON.parse(f.replies[2].text).reason, /maxProposals/);
    assert.equal(f.calls.length, 1);
    assert.equal(readdirSync(`${f.directory}/state`).filter((name) => !name.startsWith("broker-")).length, 0, "bridge started a model conversation");
  } finally { await f.close(); }
});

test("broker bridge root: unknown, wrong node, missing identity and body impersonation refuse before guards or API", async () => {
  const f = await fixture();
  try {
    for (const [i, origin] of [{ service: "other", node: principal.node }, { ...principal, node: "wrong.example" }, {}, { ...principal, id: "instance" }].entries()) f.request(`bad-${i}`, origin);
    f.request("second-json", principal, `${JSON.stringify({ kind: "gist_read", id: ID })}\n${JSON.stringify({ kind: "gist_read", id: ID })}`);
    await until(() => f.replies.length === 5);
    assert.ok(f.replies.every((reply) => JSON.parse(reply.text).acted === false));
    assert.equal(f.calls.length, 0); assert.equal(f.screens.length, 0);
  } finally { await f.close(); }
});

test("broker bridge root: guard rejection withholds fetched result and transcript", async () => {
  const f = await fixture();
  try {
    f.mode("reject"); f.request("reject"); await until(() => f.replies.length === 1);
    const result = JSON.parse(f.replies[0].text); assert.equal(result.acted, false); assert.equal(result.gist, undefined);
    assert.ok(!f.replies[0].text.includes("raw untrusted gist"));
    assert.throws(() => f.context(), /ENOENT/);
  } finally { await f.close(); }
});


test("broker bridge root: complete Action obeys negotiated result byte budget", async () => {
  const f = await fixture({ budget: 512, large: true });
  try {
    f.request("bounded"); await until(() => f.replies.length === 1);
    assert.ok(new TextEncoder().encode(f.replies[0].text).byteLength <= 512);
    const result = JSON.parse(f.replies[0].text);
    assert.equal(result.acted, false); assert.match(result.reason, /too.large|byte|limit/i);
  } finally { await f.close(); }
});


test("broker bridge root: unchanged reconnect retains operation and changed limits pause Acts", async () => {
  const f = await fixture();
  try {
    await f.reconnect(); f.request("after-same"); await until(() => f.replies.length === 1);
    assert.equal(JSON.parse(f.replies[0].text).acted, true); assert.equal(f.calls.length, 1);
    await f.reconnect(true); f.request("after-changed"); f.queueGuardReply();
    await until(() => f.replies.length === 2 && f.acks.includes("behind-paused-request"));
    assert.equal(JSON.parse(f.replies[1].text).acted, false);
    assert.match(JSON.parse(f.replies[1].text).reason, /bus limits changed|contract|restart/);
    assert.equal(f.calls.length, 1, "changed bus contract still invoked GitHub");
    assert.ok(f.acks.includes("after-changed"), "durable contract refusal did not ACK");
  } finally { await f.close(); }
});
