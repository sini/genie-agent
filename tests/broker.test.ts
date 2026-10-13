// The broker's gating oracle (design oracle 7), against a stub ninfer and a recording act: a
// proposal that fails guard-out, for any reason, is never acted on; a passing one is acted on once,
// with its credentials redacted; and the token reaches the act and nothing else.
// Run with `node --test tests/broker.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { broker, type Proposal } from "../src/broker/index.ts";

// ninfer, answering every chat completion with `content` (or HTTP `status`) and recording each
// request's headers and body.
async function ninfer(content: string, status = 200) {
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.stringify(req.headers) + body);
      res.statusCode = status;
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
}

const verdict = (v: string, reason: string) => JSON.stringify({ verdict: v, reason });

function recordingAct(fail?: (token: string) => string) {
  const calls: { p: Proposal; token: string }[] = [];
  const act = async (p: Proposal, token: string) => {
    calls.push({ p, token });
    if (fail) throw new Error(fail(token));
    return { url: "https://gist.example/1" };
  };
  return { act, calls };
}

function tokenFile(token: string) {
  const f = `${mkdtempSync(`${tmpdir()}/broker-`)}/token`;
  writeFileSync(f, `${token}\n`);
  return f;
}

// A github-token shape, generated per run.
const credential = () => `ghp_${randomBytes(27).toString("base64").replace(/[+/=]/g, "x")}`;

const gist = (text = "{ }\n") => JSON.stringify({ kind: "gist", files: { "flake.nix": text }, title: "Minimal repro", body: "From thread !abc:example.org" });

async function run(content: string, raw: string, status = 200) {
  const n = await ninfer(content, status);
  const { act, calls } = recordingAct();
  try {
    const action = await broker("!t:example.org", raw, { tokenFile: tokenFile(randomUUID()), guard: { base: n.base, model: "m", system: "guard-out" }, act });
    return { action, calls, requests: n.requests };
  } finally {
    n.close();
  }
}

test("oracle: a proposal that fails guard-out is not acted on", async () => {
  for (const [content, status, why] of [
    [verdict("block", "leak"), 200, "guard-out: leak"],
    ["Sure, I can help with that.", 200, "guard-out: guard-out output invalid: unparseable"],
    [verdict("pass", "clean"), 500, "guard-out unavailable: HTTP 500"],
  ] as const) {
    const { action, calls, requests } = await run(content, gist(), status);
    assert.equal(requests.length > 0, true, why);
    assert.equal(calls.length, 0, why);
    assert.equal(action.acted, false, why);
    assert.ok(action.reason.startsWith(why), `${action.reason} does not start with ${why}`);
  }
  const { act, calls } = recordingAct();
  const action = await broker("!t:example.org", gist(), { tokenFile: tokenFile("t"), guard: { base: "http://127.0.0.1:1/v1", model: "m", system: "s" }, act });
  assert.equal(calls.length, 0);
  assert.ok(action.reason.startsWith("guard-out unavailable: "), action.reason);
});

test("a malformed proposal is not acted on and reaches no guard", async () => {
  for (const [raw, why] of [
    ["{kind: gist", "proposal unparseable"],
    [JSON.stringify({ kind: "pr", files: { a: "b" }, title: "t", body: "" }), "not a proposal: $.repo is missing"],
  ]) {
    const { action, calls, requests } = await run(verdict("pass", "clean"), raw);
    assert.equal(calls.length, 0, why);
    assert.equal(requests.length, 0, why);
    assert.ok(action.reason.startsWith(why), action.reason);
  }
});

test("oracle: a passing proposal is acted on exactly once, with redacted content", async () => {
  const cred = credential();
  const raw = JSON.stringify({
    kind: "pr",
    repo: "alice/nix-config",
    branch: "genie/fix-foo",
    files: { "hosts/laptop.nix": `{ token = "${cred}"; }\n` },
    title: `Enable foo ${cred}`,
    body: `Thread: https://matrix.to/#/!abc:example.org\n${cred}`,
  });
  const { action, calls, requests } = await run(verdict("pass", "clean"), raw);
  assert.equal(calls.length, 1);
  assert.deepEqual(action, { thread: "!t:example.org", acted: true, reason: "acted", redactions: ["github-token", "github-token", "github-token"], url: "https://gist.example/1" });
  const sent = JSON.stringify(calls[0].p);
  assert.ok(!sent.includes(cred), sent);
  assert.equal(calls[0].p.body, "Thread: https://matrix.to/#/!abc:example.org\n[redacted:github-token]");
  assert.equal(calls[0].p.files["hosts/laptop.nix"], '{ token = "[redacted:github-token]"; }\n');
  // Guard-out judged the redacted bytes.
  assert.ok(requests.every((r) => !r.includes(cred)));
  assert.ok(requests.some((r) => r.includes("[redacted:github-token]")));
});

test("the token reaches the act and nothing else", async () => {
  const token = randomUUID();
  const n = await ninfer(verdict("pass", "clean"));
  const guard = { base: n.base, model: "m", system: "guard-out" };
  try {
    const ok = recordingAct();
    const acted = await broker("!t:example.org", gist(), { tokenFile: tokenFile(token), guard, act: ok.act });
    assert.equal(ok.calls[0].token, token);
    const failing = recordingAct((t) => `HTTP 401 for Authorization: token ${t}`);
    const failed = await broker("!t:example.org", gist(), { tokenFile: tokenFile(token), guard, act: failing.act });
    assert.equal(failed.acted, false);
    assert.equal(failed.reason, "act failed: HTTP 401 for Authorization: token [token]");
    const recorded = [JSON.stringify([acted, failed]), JSON.stringify(ok.calls.map((c) => c.p)), ...n.requests];
    assert.equal(n.requests.length, 2);
    for (const r of recorded) assert.ok(!r.includes(token), r);
    // An unreadable token is not acted on.
    const none = recordingAct();
    const missing = await broker("!t:example.org", gist(), { tokenFile: "/nonexistent/token", guard, act: none.act });
    assert.equal(none.calls.length, 0);
    assert.equal(missing.reason, "token unreadable: /nonexistent/token");
  } finally {
    n.close();
  }
});
