// The gist action's gating oracle (plan A2), through A1's real broker against a stub ninfer and a
// stub GitHub API: a gist proposal is exactly one `POST /gists`, with the redacted content and the
// Bearer token, and acts with the stub's `html_url`; any failure is not acted on, with no retry,
// and the token reaches no reason and no output.
// Run with `node --test tests/gist.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { broker, type Proposal } from "../src/broker/index.ts";
import { gist } from "../src/broker/gist.ts";

interface Req {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

// An HTTP server answering every request with `reply(req)`, recording each request.
async function stub(reply: (r: Req) => { status: number; headers?: Record<string, string>; body: string }) {
  const requests: Req[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = { method: req.method!, url: req.url!, headers: req.headers, body };
      requests.push(r);
      const out = reply(r);
      res.writeHead(out.status, out.headers).end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

const HTML_URL = "https://gist.github.com/genie-bot/aa5a315d61ae9438b18d";
const created = () => ({ status: 201, body: JSON.stringify({ id: "aa5a315d61ae9438b18d", html_url: HTML_URL }) });
const credential = () => `ghp_${randomBytes(27).toString("base64").replace(/[+/=]/g, "x")}`;

// The proposal through the broker with guard-out passing and the gist act at `github`; every byte
// written to stdout or stderr meanwhile is returned beside the action.
async function run(raw: string, github: Awaited<ReturnType<typeof stub>>, token = randomUUID()) {
  const ninfer = await stub(() => ({ status: 200, body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdict: "pass", reason: "clean" }) } }] }) }));
  const dir = mkdtempSync(`${tmpdir()}/gist-`);
  writeFileSync(`${dir}/token`, `${token}\n`);
  const output: string[] = [];
  const writes = [process.stdout, process.stderr].map((s) => {
    const write = s.write.bind(s);
    s.write = ((chunk: string | Uint8Array, ...rest: never[]) => (output.push(String(chunk)), write(chunk, ...rest))) as typeof s.write;
    return () => (s.write = write);
  });
  try {
    const action = await broker("!t:example.org", raw, { tokenFile: `${dir}/token`, guard: { base: `${ninfer.base}/v1`, model: "m", system: "guard-out" }, act: gist(github.base) });
    return { action, token, output: output.join("") };
  } finally {
    writes.forEach((restore) => restore());
    ninfer.close();
  }
}

const proposal = (files: Record<string, string>, body = "") => JSON.stringify({ kind: "gist", files, title: "Minimal repro", body });

test("oracle: a gist proposal is exactly one POST /gists with the redacted content and the Bearer token", async () => {
  const github = await stub(created);
  try {
    const cred = credential();
    const { action, token } = await run(proposal({ "flake.nix": `{ token = "${cred}"; }\n` }, `From thread !abc:example.org\n${cred}`), github);
    assert.equal(github.requests.length, 1);
    const [r] = github.requests;
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/gists");
    assert.equal(r.headers.authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(r.body), {
      description: "Minimal repro",
      public: false,
      files: {
        "flake.nix": { content: '{ token = "[redacted:github-token]"; }\n' },
        "README.md": { content: "From thread !abc:example.org\n[redacted:github-token]" },
      },
    });
    assert.deepEqual(action, { thread: "!t:example.org", acted: true, reason: "acted", redactions: ["github-token", "github-token"], url: HTML_URL });
  } finally {
    github.close();
  }
});

test("oracle: a 403 or 500 is not acted on, once, and the reason never carries the token", async () => {
  for (const [status, headers, why] of [
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1760000000" }, "act failed: gist: HTTP 403 (x-ratelimit-remaining=0, x-ratelimit-reset=1760000000): "],
    [429, { "retry-after": "60" }, "act failed: gist: HTTP 429 (retry-after=60): "],
    [500, {}, "act failed: gist: HTTP 500: "],
  ] as const) {
    // The stub echoes the Authorization header, so the token is in the act's error message.
    const github = await stub((r) => ({ status, headers, body: JSON.stringify({ message: `refused ${r.headers.authorization}` }) }));
    try {
      const { action, token, output } = await run(proposal({ "flake.nix": "{ }\n" }), github);
      assert.equal(github.requests.length, 1, why);
      assert.equal(action.acted, false, why);
      assert.equal(action.url, undefined, why);
      assert.equal(action.reason, `${why}{"message":"refused Bearer [token]"}`);
      assert.ok(!JSON.stringify(action).includes(token), "the token is in the action");
      assert.ok(!output.includes(token), "the token is on stdout or stderr");
    } finally {
      github.close();
    }
  }
});

test("oracle: a 2xx without html_url is not acted on", async () => {
  for (const body of [JSON.stringify({ id: "aa5a" }), "not json"]) {
    const github = await stub(() => ({ status: 201, body }));
    try {
      const { action } = await run(proposal({ "flake.nix": "{ }\n" }), github);
      assert.equal(github.requests.length, 1);
      assert.deepEqual([action.acted, action.reason, action.url], [false, "act failed: gist: HTTP 201 without html_url", undefined]);
    } finally {
      github.close();
    }
  }
});

test("a network error is not acted on", async () => {
  const { action } = await run(proposal({ "flake.nix": "{ }\n" }), { base: "http://127.0.0.1:1", requests: [], close() {} });
  assert.equal(action.acted, false);
  assert.ok(action.reason.startsWith("act failed: "), action.reason);
});

test("a proposal the gist cannot carry throws before any request", async () => {
  const github = await stub(created);
  try {
    const act = gist(github.base);
    const pr: Proposal = { kind: "pr", repo: "alice/x", branch: "b", files: { a: "b" }, title: "t", body: "" };
    await assert.rejects(act(pr, "t"), /gist: cannot act on a pr proposal/);
    await assert.rejects(act({ kind: "gist", files: { "README.md": "x" }, title: "t", body: "y" }, "t"), /both claim README.md/);
    assert.equal(github.requests.length, 0);
  } finally {
    github.close();
  }
});
