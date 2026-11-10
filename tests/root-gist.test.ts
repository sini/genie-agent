import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { main, type Inbound } from "../src/root/index.ts";
import { BRIDGE } from "../src/supervisor/index.ts";
import { piAiPath } from "../src/tier1/custody.ts";
import { errors, fromModel, load } from "../src/tier1/schema.ts";
import type { Envelope, Verdict } from "../src/guard/verdict.ts";

const ID = "abcdef1234567890abcdef1234567890ab";
const SHAPED = () => `ghp_${randomBytes(27).toString("hex")}`;
async function fixture(options: { anonymous?: boolean; guardOff?: boolean; quota?: number } = {}) {
  const directory = mkdtempSync(`${tmpdir()}/genie-gist-root-`);
  const token = randomUUID();
  const shaped = SHAPED();
  writeFileSync(`${directory}/model-key`, "fixture-model-key");
  writeFileSync(`${directory}/broker-key`, token);
  const pi = `${directory}/pi`;
  const sdk = piAiPath(process.env.PI ?? "pi");
  writeFileSync(pi, `#!/bin/sh\nexport PI_SETTLE=manual\nexport GENIE_PI_AI='${sdk}'\nexec '${process.execPath}' '${new URL("./fixtures/supervisor/fake-pi.ts", import.meta.url).pathname}' "$@"\n`);
  chmodSync(pi, 0o755);
  const calls: { method: string; url: string; auth: string | undefined; body: any }[] = [];
  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.url === "/user") return res.end(JSON.stringify({ login: "genie-bot" }));
      if (req.method === "GET" && req.url === `/gists/${ID}`) return res.end(JSON.stringify({ id: ID, html_url: `https://gist.github.com/account/${ID}`, description: "review", owner: { login: "account" }, history: [{ version: "a".repeat(40) }], files: { "note.md": { content: `${options.anonymous ? "anonymous public text" : token} ${shaped} untrusted prose`, truncated: false } } }));
      if (req.method === "POST" && req.url === "/gists") return res.end(JSON.stringify({ html_url: `https://gist.github.com/genie-bot/${ID}` }));
      res.writeHead(404).end("{}");
    });
  });
  let outboundCalls = 0;
  const ninfer = createServer((req, res) => {
    req.resume(); req.on("end", () => { outboundCalls++; res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdict: "pass", reason: "clean" }) } }] })); });
  });
  for (const server of [api, ninfer]) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server: typeof api) => (server.address() as { port: number }).port;
  const config = `${directory}/config.json`;
  writeFileSync(config, JSON.stringify({
    stateRoot: `${directory}/state`, storeRoot: `${directory}/store`,
    mirror: { mirrorRoot: `${directory}/mirrors`, worktreeRoot: `${directory}/worktrees` },
    pi, model: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", id: "fixture", keyFile: `${directory}/model-key` },
    tier1: { searxngUrl: "http://127.0.0.1:1", cluster: [] }, guard: { enable: !options.guardOff },
    ghScreen: { enable: false },
    broker: { tokenFile: options.anonymous ? null : `${directory}/broker-key`, githubApi: `http://127.0.0.1:${port(api)}`, maxProposalsPerThreadPerDay: options.quota,
      guardOut: options.guardOff ? { enable: false } : { base: `http://127.0.0.1:${port(ninfer)}/v1`, model: "fixture" } },
  }));
  let mode: "allow" | "rewrite" | "reject" | "error" = "allow";
  const webChecks: string[] = [];
  const guard = { check: async (envelope: Envelope): Promise<Verdict> => {
    if (envelope.source !== "web") return { verdict: "allow", reason: "clean", cleaned_text: envelope.content.text };
    webChecks.push(envelope.content.text);
    assert.ok(!envelope.content.text.includes(token), "broker token entered guard-in");
    assert.ok(!envelope.content.text.includes(shaped), "shaped credential entered guard-in");
    if (mode === "error") throw new Error(`guard unavailable ${token}`);
    if (mode === "reject") return { verdict: "reject", reason: "withhold raw gist", cleaned_text: "" };
    if (mode === "rewrite") {
      const value = JSON.parse(envelope.content.text); value.files["note.md"] = `clean rewrite ${token} ${shaped}`;
      return { verdict: "rewrite", reason: "cleaned", cleaned_text: JSON.stringify(value) };
    }
    return { verdict: "allow", reason: "clean", cleaned_text: envelope.content.text };
  } };
  const batches: Inbound[][] = [];
  const root = main(config, { intake: { next: async () => batches.shift() ?? null }, post: { post: async () => {} }, ...(options.guardOff ? {} : { guard }), xmsg: { send: async () => "fixture" } }, async () => ({ exit: 0, stdout_tail: "", stderr_tail: "", limit_hit: "none" }));
  const thread = "gist-thread";
  batches.push([{ thread, screened: true, envelope: '[matrix] room=#support:example.org thread=$root user=alice (trusted)\n\n<request screened="true">\n{"sender":"alice","sender_id":"@alice:example.org","tier":"trusted","text":"review a gist"}\n</request>' }]);
  await root.run();
  return {
    root, token, shaped, calls, webChecks, mode: (value: typeof mode) => { mode = value; }, outboundCalls: () => outboundCalls,
    context: () => JSON.parse(readFileSync(`${root.store.dir(thread)}/context.json`, "utf8")),
    propose: async (proposal: unknown) => JSON.parse(((await root.supervisor.command(thread, { type: "host", title: BRIDGE, placeholder: JSON.stringify({ method: "propose", arg: proposal }) })).data as any).value),
    close: async () => { await root.stop(); for (const server of [api, ninfer]) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } rmSync(directory, { recursive: true, force: true }); },
  };
}

test("gist root: anonymous reads use guard-in despite legacy screening default and retain quota", async () => {
  const f = await fixture({ anonymous: true, quota: 1 });
  try {
    const result = await f.propose({ kind: "gist_read", id: ID });
    assert.equal(result.ok.acted, true, JSON.stringify(result));
    assert.equal(result.ok.gist.untrusted, true);
    assert.equal(f.webChecks.length, 1);
    assert.equal(f.outboundCalls(), 0, "read request invoked outbound model");
    assert.deepEqual(f.calls.map(({ method, url, auth }) => ({ method, url, auth })), [{ method: "GET", url: `/gists/${ID}`, auth: undefined }]);
    const transcript = f.context().gh_transcript;
    assert.equal(transcript.length, 1); assert.equal(transcript[0].screened, true);
    assert.equal(JSON.parse(transcript[0].output).untrusted, true);
    assert.deepEqual(transcript[0].request, { kind: "gist_read", id: ID });
    const rejected = await f.propose({ kind: "gist_read", id: ID });
    assert.equal(rejected.ok.acted, false); assert.match(rejected.ok.reason, /maxProposals/);
    assert.equal(f.calls.length, 1, "quota refusal still fetched data");
    const write = await f.propose({ kind: "gist_comment", id: ID, body: "review" });
    assert.equal(write.ok.acted, false);
    assert.equal(f.calls.length, 1, "anonymous read configuration permitted a write");
  } finally { await f.close(); }
});

test("gist root: rewritten results are scrubbed again and rejected raw reads never enter transcripts", async () => {
  const f = await fixture();
  try {
    f.mode("rewrite");
    const clean = await f.propose({ kind: "gist_read", id: ID });
    assert.equal(clean.ok.acted, true, JSON.stringify(clean));
    assert.match(clean.ok.gist.files["note.md"], /clean rewrite/);
    for (const mode of ["reject", "error"] as const) {
      f.mode(mode);
      const rejected = await f.propose({ kind: "gist_read", id: ID });
      assert.equal(rejected.ok.acted, false); assert.equal(rejected.ok.gist, undefined);
      assert.equal(f.context().gh_transcript.length, 1);
      assert.ok(!JSON.stringify(rejected).includes(f.token));
    }
    assert.ok(!JSON.stringify([clean, f.context().gh_transcript]).includes(f.token));
    assert.ok(!JSON.stringify([clean, f.context().gh_transcript]).includes(f.shaped));
    assert.equal(f.outboundCalls(), 0);
  } finally { await f.close(); }
});

test("gist root: explicit global guard off preserves redaction and untrusted result marking", async () => {
  const f = await fixture({ guardOff: true });
  try {
    const result = await f.propose({ kind: "gist_read", id: ID });
    assert.equal(result.ok.acted, true, JSON.stringify(result));
    assert.equal(result.ok.gist.untrusted, true);
    assert.equal(f.webChecks.length, 0); assert.equal(f.outboundCalls(), 0);
    assert.equal(f.context().gh_transcript[0].screened, false);
    assert.ok(!JSON.stringify([result, f.context().gh_transcript]).includes(f.token));
    assert.ok(!JSON.stringify([result, f.context().gh_transcript]).includes(f.shaped));
  } finally { await f.close(); }
});

test("gist root: public yes no and omission reach the fake API without changing write guards", async () => {
  const f = await fixture();
  try {
    const schema = load("proposal");
    for (const [publicValue, expected] of [["yes", true], ["no", false], [undefined, false]] as const) {
      const model = { kind: "gist", files: { "note.md": "candidate" }, title: "design", body: "", ...(publicValue === undefined ? {} : { public: publicValue }) };
      const proposal = fromModel(schema, model);
      const response = await f.propose(proposal);
      assert.equal(response.ok.acted, true, JSON.stringify(response));
      assert.equal(f.calls.filter((call) => call.method === "POST").at(-1)!.body.public, expected);
    }
    assert.equal(f.outboundCalls(), 3);
  } finally { await f.close(); }
});

test("gist root: new read transcript provenance passes escalation schema without broadening legacy requests", () => {
  const valid = { thread_id: "thread", cleaned_question: "question", draft: { answer: "answer", confidence: 1, gaps: [], escalate_forced: false }, eval_transcript: [], gaps: [], gh_transcript: [{ request: { kind: "gist_read", id: "abc123" }, output: '{"untrusted":true}', screened: true }] };
  assert.deepEqual(errors(load("escalation"), valid), []);
  for (const request of [{ kind: "gist_comment", id: "abc123", body: "not a read" }, { kind: "gist_read", id: "../escape" }]) {
    const bad = { ...valid, gh_transcript: [{ ...valid.gh_transcript[0], request }] };
    assert.notDeepEqual(errors(load("escalation"), bad), []);
  }
});
