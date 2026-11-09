import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { after, test } from "node:test";
import { connect } from "node:net";
import { Custody, piAiPath } from "../src/tier1/custody.ts";
import { hostCall, modelStream } from "../src/tier1/socket.ts";
import { tier1Launch } from "../src/tier1/launch.ts";
import { Supervisor } from "../src/supervisor/index.ts";
import type { Host } from "../src/tier1/index.ts";
import { stubModel } from "./fixtures/supervisor/stub-model.ts";

const pi = process.env.PI ?? "pi";
const sdk = piAiPath(pi);
const key = "custody-test-canary-credential";
const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/custody-test-`);
const hosts: string[] = [];
const host = (thread: string) => Object.fromEntries(["recall", "eval", "reply", "escalate", "propose", "clone", "git", "gh_read", "screen", "room_context"].map((name) => [name, async (arg: unknown) => { hosts.push(`${thread}:${name}:${JSON.stringify(arg)}`); return thread; }])) as unknown as Host;

async function collect(socket: string, data: unknown): Promise<any[]> {
  const records: any[] = [];
  const c = connect(socket);
  c.write(`${JSON.stringify(data)}\n`);
  let buf = "";
  for await (const chunk of c) {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { records.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  }
  return records;
}

const context = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }] };

test("custody: configured key and destination win over pi headers and destination", async () => {
  const seen: any[] = [];
  let foreign = 0, authRequired = true;
  const attacker = createServer((_req, res) => { foreign++; res.end(); });
  await new Promise<void>((r) => attacker.listen(0, "127.0.0.1", r));
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      if (authRequired && req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401).end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const badUrl = `http://127.0.0.1:${(attacker.address() as any).port}/v1`;
  const c = new Custody({ model: { baseUrl, api: "openai-completions", id: "m", apiKey: key }, sdk, host });
  try {
    const socket = c.open("A");
    const records = await collect(socket, { method: "model", context, model: { baseUrl: badUrl, api: "anthropic-messages", id: "foreign" }, options: { headers: { authorization: "Bearer attacker", "x-pi-override": "yes" }, baseUrl: badUrl, apiKey: "attacker", samplingParams: { model: "foreign", top_p: 0.9 } } });
    assert.equal(foreign, 0, "pi supplied destination was honoured");
    assert.equal(seen[0]?.headers["x-pi-override"], undefined, "pi supplied headers were honoured");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.model, "m", "sampling options overrode configured model");
    assert.equal(seen[0].body.top_p, 0.9, "ordinary sampling option was lost");
    assert.equal(seen[0].headers.authorization, `Bearer ${key}`, "root credential was overridden");
    assert.equal(seen[0].headers["x-pi-override"], undefined, "pi supplied headers were honoured");
    assert.equal(records.at(-1)?.event?.type, "done", JSON.stringify(records));
    assert.ok(!JSON.stringify(records).includes(key));
    const wrong = new Custody({ model: { baseUrl, api: "openai-completions", id: "m", apiKey: "wrong" }, sdk, host });
    try { assert.equal((await collect(wrong.open("wrong"), { method: "model", context })).at(-1)?.event?.type, "error", "upstream must reject wrong credentials"); } finally { await wrong.close(); }
    authRequired = false;
    const empty = new Custody({ model: { baseUrl, api: "openai-completions", id: "m", apiKey: "" }, sdk, host });
    try { assert.equal((await collect(empty.open("empty"), { method: "model", context })).at(-1)?.event?.type, "done", "empty key must preserve local no-auth model compatibility"); } finally { await empty.close(); }
    const short = new Custody({ model: { baseUrl, api: "openai-completions", id: "m", apiKey: "done" }, sdk, host });
    try { assert.equal((await collect(short.open("short"), { method: "model", context })).at(-1)?.event?.type, "done", "short keys must not corrupt event protocol values"); } finally { await short.close(); }
  } finally { await c.close(); server.closeAllConnections(); server.close(); attacker.closeAllConnections(); attacker.close(); }
});

test("custody: Host authority belongs to the socket, and teardown closes it", async () => {
  hosts.length = 0;
  const c = new Custody({ model: { baseUrl: "http://127.0.0.1:1", api: "openai-completions", id: "m", apiKey: key }, sdk, host });
  const a = c.open("A"), b = c.open("B");
  try {
    assert.deepEqual(await collect(a, { method: "host", name: "recall", arg: "q", thread: "B" }), [{ ok: "A" }]);
    assert.equal(await hostCall(b, "recall", "q"), "B");
    assert.deepEqual(hosts, ['A:recall:"q"', 'B:recall:"q"']);
    assert.match((await collect(a, { method: "host", name: "constructor", arg: {} }))[0].error, /Host method/);
    await c.closeThread("A");
    await assert.rejects(hostCall(a, "recall", "q"));
    assert.equal(await hostCall(b, "recall", "still alive"), "B");
  } finally { await c.close(); }
});

test("custody: provider errors redact credentials and cancellation aborts upstream", async () => {
  let cancelled = false;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/error/chat/completions") { res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: key } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"start"},"finish_reason":null}]}\n\n');
    res.on("close", () => { cancelled = true; });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const c = new Custody({ model: { baseUrl: `${url}/error`, api: "openai-completions", id: "m", apiKey: key }, sdk, host });
  const stream = new Custody({ model: { baseUrl: url, api: "openai-completions", id: "m", apiKey: key }, sdk, host });
  try {
    const r = await collect(c.open("errors"), { method: "model", context });
    assert.equal(r.at(-1)?.event?.type, "error");
    assert.ok(!JSON.stringify(r).includes(key), "upstream error disclosed root credential");
    const abort = new AbortController();
    const events = modelStream(stream.open("stream"), {}, context, { signal: abort.signal });
    for await (const e of events) { if (e.type === "text_delta") { abort.abort(); break; } }
    await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error("upstream cancellation missing")), 2000); const check = () => cancelled ? (clearTimeout(t), resolve()) : setTimeout(check, 10); check(); });
  } finally { await c.close(); await stream.close(); server.closeAllConnections(); server.close(); }
});

test("custody: Anthropic API retains its own authentication and stream semantics", async () => {
  let auth: string | undefined, bearer: string | undefined;
  const server = createServer((req, res) => {
    auth = String(req.headers["x-api-key"]); bearer = req.headers.authorization;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, body: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
      res.end(event("message_start", { message: { id: "msg_x", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }) + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "anthropic-ok" } }) + event("content_block_stop", { index: 0 }) + event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + event("message_stop", {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const c = new Custody({ model: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, api: "anthropic-messages", id: "m", apiKey: key }, sdk, host });
  try {
    const r = await collect(c.open("anthropic"), { method: "model", context });
    assert.equal(r.at(-1)?.event?.type, "done", JSON.stringify(r));
    assert.equal(auth, key); assert.equal(bearer, undefined);
    assert.ok(r.some((e) => e.event?.delta === "anthropic-ok"));
  } finally { await c.close(); server.closeAllConnections(); server.close(); }
});

test("custody: actual packaged pi streams and round-trips a Host tool through root", { timeout: 30000 }, async () => {
  const model = await stubModel({ apiKey: key });
  const c = new Custody({ model: { baseUrl: model.url, api: "openai-completions", id: "m", apiKey: key }, sdk, host });
  const launch = tier1Launch({ pi, agentDir: `${tmp}/agent`, custody: (t) => ({ socket: c.open(t), model: c.publicModel, sdk }), config: (t) => ({ root: `${tmp}/worktrees/${t}`, searxngUrl: "http://127.0.0.1:1", cluster: [] }), args: () => ["--model", "genie/m", "--no-session"] });
  let settled: () => void = () => {};
  const done = new Promise<void>((r) => { settled = r; });
  const s = new Supervisor(launch, (_t, e) => { if (e.type === "agent_settled") settled(); }, host);
  try {
    process.env.ROOT_SECRET_TEST = key;
    const spec = launch("A");
    assert.ok(!JSON.stringify(spec.args).includes(key), "root credential appeared in pi argv");
    assert.ok(!JSON.stringify(spec.env).includes(key), "root credential appeared in pi env");
    assert.ok(!readFileSync(`${tmp}/agent/models.json`, "utf8").includes(key), "root credential appeared in models.json");
    const r = await s.command("A", { type: "prompt", message: JSON.stringify({ tool: "recall", args: { query: "custody" } }) });
    assert.equal(r.success, true, JSON.stringify(r));
    await done;
    assert.ok(hosts.includes('A:recall:"custody"'), JSON.stringify((await s.command("A", { type: "get_messages" })).data?.messages?.filter((m: any) => m.role === "assistant")));
    assert.ok(model.requests.length >= 2, "real pi did not complete tool round trip");
    assert.ok(model.authentications.every((a) => a === `Bearer ${key}`));
    const pids = [s.pid("A")!];
    for (const pid of pids) {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      if (children) pids.push(...children.split(/\s+/).map(Number));
    }
    assert.ok(pids.length >= 2, "must inspect actual pi beyond bwrap");
    for (const pid of pids) {
      assert.ok(!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(key), "actual child argv contains credential");
      assert.ok(!readFileSync(`/proc/${pid}/environ`, "utf8").includes(key), "actual child env contains credential");
    }
    assert.ok(JSON.stringify((await s.command("A", { type: "get_messages" })).data).includes("done"));
    const credentialFile = `${tmp}/root-key`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(credentialFile, key);
    const nextDone = new Promise<void>((resolve) => { settled = resolve; });
    await s.command("A", { type: "prompt", message: JSON.stringify({ tool: "read", args: { path: credentialFile } }) });
    await nextDone;
    const transcript = JSON.stringify((await s.command("A", { type: "get_messages" })).data);
    assert.ok(!transcript.includes(key), "pi read tool disclosed root credential");
    assert.match(transcript, /outside|refused|not permitted/, "read policy must refuse root credential file");
  } finally { delete process.env.ROOT_SECRET_TEST; await s.shutdown(); await c.close(); model.close(); }
});
