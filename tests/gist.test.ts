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
import { gist, gistRead, gistUpdate, gistComment } from "../src/broker/gist.ts";

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


const GIST_ID = "aa5a315d61ae9438b18d";
const revision = "a".repeat(40);
const gistMetadata = (owner: string | null = "genie-bot", content = "reviewable content") => ({
  id: GIST_ID, html_url: HTML_URL, description: "Example", owner: owner === null ? null : { login: owner },
  history: [{ version: revision }], truncated: false,
  files: { "example.txt": { filename: "example.txt", content, truncated: false } },
});

test("oracle B1: an anonymous gist read is complete untrusted data with no credential or raw URL fetch", async () => {
  const metadata = gistMetadata(null);
  const github = await stub((r) => {
    assert.equal(r.method, "GET"); assert.equal(r.url, `/gists/${GIST_ID}`);
    return { status: 200, body: JSON.stringify(metadata) };
  });
  try {
    const result = await gistRead(github.base)({ kind: "gist_read", id: HTML_URL }, "", "thread");
    assert.deepEqual(result, { url: HTML_URL, gist: { untrusted: true, id: GIST_ID, url: HTML_URL, description: "Example", owner: null, revision, files: { "example.txt": "reviewable content" } } });
    assert.equal(github.requests.length, 1);
    assert.equal(github.requests[0].headers.authorization, undefined);
  } finally { github.close(); }
});

test("oracle B1: oversized metadata and incomplete or truncated files are refused without raw fallback", async () => {
  for (const change of [
    { truncated: true },
    { files: { "example.txt": { content: "short", truncated: true, raw_url: "https://raw.example/never" } } },
    { files: { "example.txt": { truncated: false, raw_url: "https://raw.example/never" } } },
    { history: [] },
    { files: { "example.txt": { content: "x".repeat(65536), truncated: false } } },
    { files: { "example.txt": { content: "é".repeat(40000), truncated: false } } },
  ]) {
    const github = await stub(() => ({ status: 200, body: JSON.stringify({ ...gistMetadata(), ...change }) }));
    try {
      await assert.rejects(gistRead(github.base)({ kind: "gist_read", id: GIST_ID }, "", "thread"));
      assert.equal(github.requests.length, 1, "read must not fetch raw_url or retry");
    } finally { github.close(); }
  }
});

test("oracle B3: gist updates require the authenticated configured account to own the target", async () => {
  for (const [authenticated, owner, allowed] of [["genie-bot", "genie-bot", true], ["genie-bot", "another-user", false], ["genie-bot", null, false], ["personal-user", "genie-bot", false]] as const) {
    const github = await stub((r) => {
      if (r.url === "/user") return { status: 200, body: JSON.stringify({ login: authenticated }) };
      if (r.method === "GET") return { status: 200, body: JSON.stringify(gistMetadata(owner)) };
      assert.equal(r.method, "PATCH"); assert.equal(r.url, `/gists/${GIST_ID}`);
      assert.deepEqual(JSON.parse(r.body), { description: "Updated", files: { "example.txt": { content: "new content" } } });
      return { status: 200, body: JSON.stringify(gistMetadata()) };
    });
    try {
      const invoke = () => gistUpdate(github.base)({ kind: "gist_update", id: GIST_ID, title: "Updated", files: { "example.txt": "new content" } }, "fixture-token", "thread");
      if (allowed) assert.deepEqual(await invoke(), { url: HTML_URL });
      else await assert.rejects(invoke);
      assert.equal(github.requests.filter((r) => r.method === "PATCH").length, allowed ? 1 : 0, "foreign or wrong-account gist must not be patched");
    } finally { github.close(); }
  }
});

test("gist comments use a canonical gist link plus the official id-only comment receipt", async () => {
  const github = await stub((r) => {
    if (r.url === "/user") return { status: 200, body: JSON.stringify({ login: "genie-bot" }) };
    if (r.method === "GET") return { status: 200, body: JSON.stringify(gistMetadata("another-user")) };
    assert.equal(r.url, `/gists/${GIST_ID}/comments`);
    assert.deepEqual(JSON.parse(r.body), { body: "Review reply" });
    return { status: 201, body: JSON.stringify({ id: 123, url: `https://api.github.com/gists/${GIST_ID}/comments/123`, body: "Review reply", user: { login: "genie-bot" } }) };
  });
  try {
    const result = await gistComment(github.base)({ kind: "gist_comment", id: GIST_ID, body: "Review reply" }, "fixture-token", "thread");
    assert.deepEqual(result, { url: `${HTML_URL}#gistcomment-123` });
    assert.deepEqual(github.requests.map((r) => `${r.method} ${r.url}`), ["GET /user", `GET /gists/${GIST_ID}`, `POST /gists/${GIST_ID}/comments`]);
  } finally { github.close(); }
});

test("oracle B4: gist creation is secret unless public is explicitly true", async () => {
  for (const publicFlag of [undefined, false, true]) {
    const github = await stub(created);
    try {
      await gist(github.base)({ kind: "gist", title: "t", body: "", files: { a: "content" }, ...(publicFlag === undefined ? {} : { public: publicFlag }) }, "fixture-token", "thread");
      assert.equal(JSON.parse(github.requests[0].body).public, publicFlag === true, "gist default must remain secret");
    } finally { github.close(); }
  }
});


test("gist reads count chunked bytes and accept exactly the raw-response boundary", async () => {
  const metadata = { ...gistMetadata(), padding: "" };
  metadata.padding = "x".repeat(65_536 - Buffer.byteLength(JSON.stringify(metadata)));
  const boundary = JSON.stringify(metadata);
  assert.equal(Buffer.byteLength(boundary), 65_536);
  for (const [body, accepted] of [[boundary, true], [boundary + " ", false]] as const) {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.write(body.slice(0, 32_768));
      setImmediate(() => res.end(body.slice(32_768)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const act = gistRead(`http://127.0.0.1:${port}`)({ kind: "gist_read", id: GIST_ID }, "", "thread");
      if (accepted) assert.equal((await act).gist?.files["example.txt"], "reviewable content");
      else await assert.rejects(act, /exceeds 65536 bytes/);
      assert.equal(requests, 1);
    } finally { server.closeAllConnections(); server.close(); }
  }
});

test("gist reads reject oversized Content-Length before parsing and never follow redirects or retry", async () => {
  for (const response of [
    { status: 200, headers: { "content-length": "65537" }, body: "{" },
    { status: 302, headers: { location: "/raw/private" }, body: "" },
    { status: 503, headers: { "retry-after": "0" }, body: "unavailable" },
  ]) {
    const github = await stub(() => response);
    try {
      await assert.rejects(gistRead(github.base)({ kind: "gist_read", id: GIST_ID }, "", "thread"));
      assert.equal(github.requests.length, 1);
    } finally { github.close(); }
  }
});

test("write metadata has a separate bounded budget and invalid comment receipts are refused", async () => {
  for (const kind of ["gist_update", "gist_comment"] as const) {
    const github = await stub((r) => r.url === "/user"
      ? { status: 200, body: JSON.stringify({ login: "genie-bot" }) }
      : { status: 200, body: JSON.stringify({ ...gistMetadata(), padding: "x".repeat(1_048_576) }) });
    try {
      const act = kind === "gist_update" ? gistUpdate(github.base) : gistComment(github.base);
      const p: Proposal = kind === "gist_update" ? { kind, id: GIST_ID, files: { "repro.txt": "new" } } : { kind, id: GIST_ID, body: "comment" };
      await assert.rejects(act(p, "fixture-credential", "thread"), /exceeds 1048576 bytes/);
      assert.equal(github.requests.filter((r) => r.method !== "GET").length, 0);
    } finally { github.close(); }
  }
  const github = await stub((r) => ({ status: 200, body: JSON.stringify(r.url === "/user" ? { login: "genie-bot" } : r.method === "POST" ? { url: "https://api.github.com/comments/123" } : gistMetadata()) }));
  try { await assert.rejects(gistComment(github.base)({ kind: "gist_comment", id: GIST_ID, body: "comment" }, "fixture-credential", "thread"), /missing comment ID/); }
  finally { github.close(); }
});

test("anonymous credentials enable only reads; authenticated reads retain bot identity checks", async () => {
  const github = await stub((r) => ({ status: 200, body: JSON.stringify(r.url === "/user" ? { login: "personal-user" } : gistMetadata()) }));
  try {
    await assert.rejects(gist(github.base)({ kind: "gist", title: "repro", body: "body" }, "", "thread"), /credential is required/);
    await assert.rejects(gistUpdate(github.base)({ kind: "gist_update", id: GIST_ID, files: { "example.txt": "new" } }, "", "thread"), /credential is required/);
    await assert.rejects(gistComment(github.base)({ kind: "gist_comment", id: GIST_ID, body: "comment" }, "", "thread"), /credential is required/);
    assert.equal(github.requests.length, 0);
    await assert.rejects(gistRead(github.base)({ kind: "gist_read", id: GIST_ID }, "fixture-credential", "thread"), /identity|login|account/i);
    assert.deepEqual(github.requests.map((r) => r.url), ["/user"]);
  } finally { github.close(); }
});
