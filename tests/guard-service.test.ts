// genie-guard's gating oracle (genie-solicit-design.md, G1), against a mock ninfer and an xmsg
// fake: a model verdict is relayed as the parsed verdict, never the model's text; a malformed
// model reply is a reject; no review (ninfer down, an HTTP error, a timeout) and a message that is
// not an envelope are `{"error": …}`, never a verdict. Run with `node --test tests/guard-service.test.ts`.
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { SocketXmsg, type Inbound } from "../src/dispatcher/xmsg.ts";
import { config, ConfigError } from "../src/guard/config.ts";
import { awaitModel, envelopeErrors, firstModel, isConnectionError, type Ninfer, review, serve, start, step, Unauthorized, Unavailable } from "../src/guard/service.ts";
import { type Envelope, PARSE_FAILURE } from "../src/guard/verdict.ts";

const system = "the guard prompt";
const systemWeb = "the web guard prompt";
const env: Envelope = {
  source: "message",
  history: [{ sender: "@a:example.org", tier: "trusted", text: "earlier" }],
  content: { sender: "@b:example.org", tier: "public", text: "how do I pin nixpkgs?" },
};

// ninfer, answering every chat completion with `answer` and recording each request body.
// With `key`, a request lacking `Authorization: Bearer <key>` is answered 401. `calls` records each
// request's method, path and Authorization header.
async function ninfer(answer: (res: ServerResponse) => void, key?: string) {
  const requests: any[] = [];
  const calls: { method?: string; url?: string; authorization?: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      if (key !== undefined && req.headers.authorization !== `Bearer ${key}`) {
        res.statusCode = 401;
        return res.end("unauthorized");
      }
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "m" }] }));
      requests.push(JSON.parse(body));
      answer(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const n: Ninfer = { base: `http://127.0.0.1:${port}/v1`, model: "m", system, systemWeb, timeoutMs: 300 };
  const close = () => new Promise((r) => server.close(r).closeAllConnections());
  return { n, requests, calls, close };
}
const says = (content: string) => (res: ServerResponse) =>
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));

// One message through the service; resolves to the parsed reply. The log shows reply before ack.
async function once(n: Ninfer, text: string) {
  const log: string[] = [];
  const queue: Inbound[] = [{ id: "m1", text }];
  let reply = "";
  const x = {
    poll: async () => queue[0] ?? null,
    reply: async (id: string, t: string) => {
      log.push(`reply ${id}`);
      reply = t;
    },
    ack: async (id: string) => {
      log.push(`ack ${id}`);
      queue.shift();
    },
  };
  assert.equal((await step(x, n, 0))?.id, "m1");
  assert.deepEqual(log, ["reply m1", "ack m1"]);
  return { reply, parsed: JSON.parse(reply) };
}

const verdicts = [
  { verdict: "allow", reason: "an ordinary question", cleaned_text: env.content.text },
  { verdict: "rewrite", reason: "drops a planted rule", cleaned_text: "how do I pin nixpkgs" },
  { verdict: "reject", reason: "seeks credentials", cleaned_text: "" },
];
for (const v of verdicts)
  test(`a model ${v.verdict} is relayed as exactly that verdict, not the model's text`, async () => {
    // Pretty-printed, so the model's text differs from the verdict the service serialises.
    const { n, requests, close } = await ninfer(says(JSON.stringify(v, null, 2)));
    try {
      const { reply } = await once(n, JSON.stringify(env));
      assert.equal(reply, JSON.stringify(v));
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0], {
        model: "m",
        temperature: 0,
        max_tokens: 2048,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(env) },
        ],
      });
    } finally {
      await close();
    }
  });

test("a garbage model reply is relayed as a reject with the parse-failure reason", async () => {
  const { n, close } = await ninfer(says("sure! {verdict: allow}"));
  try {
    const { parsed } = await once(n, JSON.stringify(env));
    assert.deepEqual(parsed, { verdict: "reject", reason: `${PARSE_FAILURE}unparseable`, cleaned_text: "" });
  } finally {
    await close();
  }
});

const isError = (parsed: unknown, why: RegExp) => {
  assert.deepEqual(Object.keys(parsed as object), ["error"]);
  assert.match((parsed as { error: string }).error, why);
};

test("ninfer down is an error reply, not a verdict", async () => {
  const { n, close } = await ninfer(says("{}"));
  await close();
  isError((await once(n, JSON.stringify(env))).parsed, /^guard-in unavailable: /);
});

test("an HTTP 500 from ninfer is an error reply, not a verdict", async () => {
  const { n, close } = await ninfer((res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  try {
    isError((await once(n, JSON.stringify(env))).parsed, /^guard-in unavailable: HTTP 500 boom$/);
  } finally {
    await close();
  }
});

test("a ninfer timeout is an error reply, not a verdict", async () => {
  const { n, close } = await ninfer(() => {});
  try {
    isError((await once(n, JSON.stringify(env))).parsed, /^guard-in unavailable: .*TimeoutError/);
  } finally {
    await close();
  }
});

test("a chat completion with no message content is an error reply, not a verdict", async () => {
  const { n, close } = await ninfer((res) => res.end("{}"));
  try {
    isError((await once(n, JSON.stringify(env))).parsed, /^guard-in unavailable: no message content/);
  } finally {
    await close();
  }
});

// A model reasoning in a loop: cut off at max_tokens with no content.
const loops = (res: ServerResponse) =>
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null }, finish_reason: "length" }] }));

test("a reply cut off once is asked again, and the second reply's verdict is returned", async () => {
  let answered = 0;
  const { n, requests, close } = await ninfer((res) => (answered++ ? says(JSON.stringify(verdicts[2])) : loops)(res));
  try {
    assert.equal((await review(env, n)).verdict.verdict, "reject");
    assert.equal(requests.length, 2);
  } finally {
    await close();
  }
});

test("a reply cut off twice is Unavailable after exactly two requests", async () => {
  const { n, requests, close } = await ninfer(loops);
  try {
    await assert.rejects(review(env, n), (e) => e instanceof Unavailable && /cut off at max_tokens/.test(e.message));
    assert.equal(requests.length, 2);
  } finally {
    await close();
  }
});

test("an HTTP error is Unavailable after exactly one request, never retried", async () => {
  const { n, requests, close } = await ninfer((res) => {
    res.statusCode = 500;
    res.end("boom");
  });
  try {
    await assert.rejects(review(env, n), (e) => e instanceof Unavailable && /^HTTP 500/.test(e.message));
    assert.equal(requests.length, 1);
  } finally {
    await close();
  }
});

const notEnvelopes: [string, string][] = [
  ["unparseable", "hello genie"],
  ["an array", "[]"],
  ["a missing content", JSON.stringify({ source: "message", history: [] })],
  ["an unknown source", JSON.stringify({ ...env, source: "unknown" })],
  ["an unknown key", JSON.stringify({ ...env, trusted: true })],
  ["a line tier outside trusted|public", JSON.stringify({ ...env, history: [{ ...env.history[0], tier: "owner" }] })],
  ["a message with no tier", JSON.stringify({ ...env, content: { sender: "@b:example.org", text: "hi" } })],
  ["eval output with a sender", JSON.stringify({ ...env, source: "eval_stdout", content: env.content })],
  ["web content with a sender", JSON.stringify({ source: "web", history: [], content: env.content })],
];
for (const [what, text] of notEnvelopes)
  test(`a non-envelope (${what}) is an error reply and never reaches the model`, async () => {
    const { n, requests, close } = await ninfer(says(JSON.stringify(verdicts[0])));
    try {
      isError((await once(n, text)).parsed, /^not an envelope: /);
      assert.equal(requests.length, 0);
    } finally {
      await close();
    }
  });

test("eval output, recall and web envelopes, which carry no sender, reach the model", async () => {
  for (const source of ["eval_stdout", "recall", "web"] as const) {
    const e: Envelope = { source, history: [], content: { text: "error: attribute missing" } };
    const { n, requests, close } = await ninfer(says(JSON.stringify({ ...verdicts[0], cleaned_text: e.content.text })));
    try {
      assert.equal((await once(n, JSON.stringify(e))).parsed.verdict, "allow");
      assert.equal(requests.length, 1);
    } finally {
      await close();
    }
  }
});

test("oracle 1: envelopeErrors accepts a web envelope and refuses sender, tier or unknown source", () => {
  const e = { source: "web", history: [], content: { text: "hello world" } };
  assert.deepEqual(envelopeErrors(e), []);
  assert.deepEqual(envelopeErrors({ ...e, source: "unknown" }), ["source not in message|eval_stdout|recall|web"]);
  assert.deepEqual(envelopeErrors({ ...e, content: { ...e.content, sender: "@a:example.org" } }), ["unknown key content.sender"]);
  assert.deepEqual(envelopeErrors({ ...e, content: { ...e.content, tier: "public" } }), ["unknown key content.tier"]);
});

test("no message within the wait replies and acks nothing", async () => {
  const x = {
    poll: async () => null,
    reply: async () => assert.fail("replied"),
    ack: async () => assert.fail("acked"),
  };
  assert.equal(await step(x, { base: "http://127.0.0.1:1/v1", model: "m", system }, 0), null);
});

const keyFile = (content: string) => {
  const f = `${mkdtempSync(`${tmpdir()}/guard-key-`)}/key`;
  writeFileSync(f, content);
  return f;
};
const cfg = (...argv: string[]) => config(["--ninfer-url", "http://x/v1", ...argv], { XDG_RUNTIME_DIR: "/run" });

test("a configured key is sent as a Bearer on /v1/models and on /v1/chat/completions", async () => {
  const { n, calls, close } = await ninfer(says(JSON.stringify(verdicts[0])), "sekrit");
  try {
    const c = cfg("--api-key-file", keyFile("sekrit\n"));
    assert.equal(c.apiKey, "sekrit");
    assert.equal(await firstModel(n.base, c.apiKey), "m");
    assert.equal((await once({ ...n, apiKey: c.apiKey }, JSON.stringify(env))).parsed.verdict, "allow");
    assert.deepEqual(
      calls.map((x) => [x.url, x.authorization]),
      [
        ["/v1/models", "Bearer sekrit"],
        ["/v1/chat/completions", "Bearer sekrit"],
      ],
    );
  } finally {
    await close();
  }
});

test("with no key configured no Authorization header is sent", async () => {
  const { n, calls, close } = await ninfer(says(JSON.stringify(verdicts[0])));
  try {
    assert.equal(cfg().apiKey, undefined);
    await firstModel(n.base, cfg().apiKey);
    await once(n, JSON.stringify(env));
    assert.deepEqual(
      calls.map((x) => x.url),
      ["/v1/models", "/v1/chat/completions"],
    );
    assert.deepEqual(calls.map((x) => x.authorization), [undefined, undefined]);
  } finally {
    await close();
  }
});

test("a 401 for a missing or wrong key is an error reply, not a verdict, and does not echo the key", async () => {
  const { n, close } = await ninfer(says(JSON.stringify(verdicts[0])), "sekrit");
  try {
    for (const apiKey of [undefined, "wrong-key"]) {
      const { reply, parsed } = await once({ ...n, apiKey }, JSON.stringify(env));
      isError(parsed, /^guard-in unavailable: HTTP 401 unauthorized$/);
      assert.ok(!reply.includes("wrong-key") && !reply.includes("sekrit"));
    }
  } finally {
    await close();
  }
});

test("an api-key file that is empty, blank or unreadable is a config error naming the flag", () => {
  for (const f of [keyFile(""), keyFile(" \n\t"), "/nonexistent/guard-key"])
    assert.throws(() => cfg("--api-key-file", f), (e) => e instanceof ConfigError && /^--api-key-file: /.test(e.message));
});

test("GENIE_GUARD_API_KEY_FILE is the environment spelling of --api-key-file", () => {
  const c = config(["--ninfer-url", "http://x/v1"], { XDG_RUNTIME_DIR: "/run", GENIE_GUARD_API_KEY_FILE: keyFile("k1") });
  assert.equal(c.apiKey, "k1");
});

// G4: /v1/models answers `status` per attempt (the last one repeats); `order` records probes and registers.
async function modelsAt(statuses: number[]) {
  const order: string[] = [];
  const server = createServer((_req, res) => {
    order.push("probe");
    const code = statuses[Math.min(order.length - 1, statuses.length - 1)];
    res.statusCode = code;
    res.end(code === 200 ? JSON.stringify({ data: [{ id: "m" }] }) : "no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const x = { register: async () => void order.push("register") };
  const close = () => new Promise((r) => server.close(r).closeAllConnections());
  return { c: { ...cfg(), base: `http://127.0.0.1:${port}/v1` }, x, order, close };
}
const quiet = { sleep: async () => {}, log: () => {} };

test("a model down at start is retried with backoff until it is up, then the guard registers", { timeout: 5000 }, async () => {
  const { c, x, order, close } = await modelsAt([503, 503, 503, 200]);
  const waits: number[] = [];
  try {
    const n = await start(c, x, system, systemWeb, async (ms) => void waits.push(ms), () => {});
    assert.equal(n.model, "m");
    assert.deepEqual(order, ["probe", "probe", "probe", "probe", "register"]);
    assert.deepEqual(waits, [2000, 4000, 8000]);
  } finally {
    await close();
  }
});

test("the backoff caps at 60 s", { timeout: 5000 }, async () => {
  const { c, x, close } = await modelsAt([503, 503, 503, 503, 503, 503, 503, 503, 200]);
  const waits: number[] = [];
  try {
    await start(c, x, system, systemWeb, async (ms) => void waits.push(ms), () => {});
    assert.deepEqual(waits, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  } finally {
    await close();
  }
});

test("with the model pinned and ninfer down, awaitModel waits and only returns once ninfer answers", async () => {
  const { c, close } = await modelsAt([503, 503, 200]);
  const waits: number[] = [];
  try {
    const model = await awaitModel(c.base, undefined, "pinned", async (ms) => void waits.push(ms), () => {});
    assert.equal(model, "pinned");
    assert.deepEqual(waits, [2000, 4000], "must wait with backoff while ninfer is down even when model is pinned");
  } finally {
    await close();
  }
});

test("register is called only after the model probe succeeds", { timeout: 5000 }, async () => {
  const { c, x, order, close } = await modelsAt([503, 200]);
  try {
    await start(c, x, system, systemWeb, quiet.sleep, quiet.log);
    assert.ok(order.indexOf("register") > order.lastIndexOf("probe"), order.join());
    assert.equal(order.filter((o) => o === "register").length, 1);
  } finally {
    await close();
  }
});

test("a 401 or 403 at start is Unauthorized, not retried, and the guard never registers", { timeout: 5000 }, async () => {
  for (const code of [401, 403]) {
    const { c, x, order, close } = await modelsAt([code]);
    const ac = new AbortController();
    try {
      await assert.rejects(
        start(c, x, system, systemWeb, async () => { ac.abort(); }, quiet.log, ac.signal),
        (e) => e instanceof Unauthorized && e.message === `${c.base}: unauthorized (check --api-key-file)`,
      );
      assert.deepEqual(order, ["probe"]);
    } finally {
      ac.abort();
      await close();
    }
  }
});

test("oracle 1: review sends guard-web prompt for web, and guard-in prompt for others", async () => {
  const { n, requests, close } = await ninfer(says(JSON.stringify(verdicts[0])));
  try {
    const cases: { source: Envelope["source"]; expected: string }[] = [
      { source: "web", expected: systemWeb },
      { source: "message", expected: system },
      { source: "eval_stdout", expected: system },
      { source: "recall", expected: system },
    ];
    for (const c of cases) {
      const e: Envelope = {
        source: c.source,
        history: [],
        content: c.source === "message" ? { sender: "@u:x", tier: "public", text: "hi" } : { text: "hi" },
      };
      await review(e, n);
      const last = requests[requests.length - 1];
      const sysMsg = last.messages.find((m: any) => m.role === "system");
      assert.equal(sysMsg?.content, c.expected, `source ${c.source} should send ${c.expected}`);
    }
  } finally {
    await close();
  }
});

test("oracle 4: a stub register.sock with no agent.sock receives the reply frame", async () => {
  const dir = mkdtempSync(`${tmpdir()}/guard-reg-`);
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
  const reg = createNetServer(lines((f) =>
    f.harness ? { status: "ok", sessionId: "svc:genie-guard" }
    : f.action === "poll" ? { action: "deliver", messageId: "01A", text: JSON.stringify(env) }
    : { status: "ok" }));
  await new Promise<void>((r) => reg.listen(`${dir}/register.sock`, r));

  const { n, close } = await ninfer(says(JSON.stringify(verdicts[0])));
  const x = new SocketXmsg(dir, "genie-guard");
  try {
    await x.register();
    const m = await step(x, n, 1000);
    assert.deepEqual(m, { id: "01A", text: JSON.stringify(env) });
    const replyFrame = frames.find((f) => f.action === "reply");
    assert.ok(replyFrame, "reply frame must be received on register.sock");
    assert.equal(replyFrame.messageId, "01A");
    assert.deepEqual(JSON.parse(replyFrame.text), verdicts[0]);
    assert.deepEqual(frames.map((f) => f.action ?? f.harness), ["svc", "poll", "reply", "ack"]);
  } finally {
    x.close();
    reg.close();
    await close();
  }
});

// -----------------------------------------------------------------------------
// Oracle 1: Stub register.sock server. The guard registers and polls. The stub
// closes the connection, then accepts a new one. The guard re-registers on the
// new connection and polls again, and the process doesn't exit.
// Mutant in src/guard/service.ts: rethrow on close (today's behaviour) => RED
// -----------------------------------------------------------------------------
test("oracle 1: guard re-registers when xmsg drops connection and process does not exit", async () => {
  const dir = mkdtempSync(`${tmpdir()}/guard-reg-reconnect-`);
  const framesConn1: any[] = [];
  const framesConn2: any[] = [];
  let connectionCount = 0;
  let deliveredConn2 = false;
  const regSockets = new Set<any>();
  let onAck: () => void = () => {};
  const acked = new Promise<void>((r) => {
    onAck = r;
  });

  const reg = createNetServer((c: any) => {
    regSockets.add(c);
    c.on("close", () => regSockets.delete(c));
    connectionCount++;
    const currentConn = connectionCount;
    let buf = "";
    c.setEncoding("utf8");

    c.on("data", (d: string) => {
      for (buf += d; buf.includes("\n"); buf = buf.slice(buf.indexOf("\n") + 1)) {
        const f = JSON.parse(buf.slice(0, buf.indexOf("\n")));
        if (currentConn === 1) {
          framesConn1.push(f);
          if (f.harness) {
            c.write(`${JSON.stringify({ status: "ok", sessionId: "svc:genie-guard" })}\n`);
          } else if (f.action === "poll") {
            // Drop connection while guard is polling
            c.destroy();
          }
        } else {
          framesConn2.push(f);
          if (f.harness) {
            c.write(`${JSON.stringify({ status: "ok", sessionId: "svc:genie-guard" })}\n`);
          } else if (f.action === "poll") {
            if (!deliveredConn2) {
              deliveredConn2 = true;
              c.write(`${JSON.stringify({ action: "deliver", messageId: "01B", text: JSON.stringify(env) })}\n`);
            } else {
              c.write(`${JSON.stringify({ action: "timeout" })}\n`);
            }
          } else if (f.action === "ack") {
            c.write(`${JSON.stringify({ status: "ok" })}\n`);
            onAck();
          } else {
            c.write(`${JSON.stringify({ status: "ok" })}\n`);
          }
        }
      }
    });
  });

  await new Promise<void>((r) => reg.listen(`${dir}/register.sock`, r));
  const { n, close: closeNinfer } = await ninfer(says(JSON.stringify(verdicts[0])));
  const x = new SocketXmsg(dir, "genie-guard");
  const ac = new AbortController();
  const c = { ...cfg(), base: n.base, xmsgDir: dir };

  try {
    const servePromise = serve(c, x, system, systemWeb, {
      pollWaitMs: 500,
      signal: ac.signal,
      wait: async () => {}, // instant retry in test
    });

    await acked;
    ac.abort();
    await servePromise;

    assert.equal(connectionCount, 2, "guard must reconnect to register.sock after drop");
    assert.deepEqual(framesConn1.map((f) => f.action ?? f.harness), ["svc", "poll"]);
    assert.deepEqual(framesConn2.slice(0, 4).map((f) => f.action ?? f.harness), ["svc", "poll", "reply", "ack"]);
  } finally {
    ac.abort();
    x.close();
    for (const s of regSockets) s.destroy();
    reg.close();
    await closeNinfer();
  }
});

// -----------------------------------------------------------------------------
// Oracle 2: Stub absent at start. The guard retries and registers once the stub appears.
// Mutant in src/guard/service.ts: no retry on ENOENT => RED
// -----------------------------------------------------------------------------
test("oracle 2: stub absent at start retries with backoff and registers once stub appears", async () => {
  const dir = mkdtempSync(`${tmpdir()}/guard-reg-absent-`);
  const sockPath = `${dir}/register.sock`;
  const waits: number[] = [];
  const logs: string[] = [];
  let regServer: any = null;
  const frames: any[] = [];
  let delivered = false;
  const regSockets = new Set<any>();
  let onAck: () => void = () => {};
  const acked = new Promise<void>((r) => {
    onAck = r;
  });

  const { n, close: closeNinfer } = await ninfer(says(JSON.stringify(verdicts[0])));
  const x = new SocketXmsg(dir, "genie-guard");
  const ac = new AbortController();
  const c = { ...cfg(), base: n.base, xmsgDir: dir };

  try {
    const servePromise = serve(c, x, system, systemWeb, {
      pollWaitMs: 500,
      signal: ac.signal,
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === 2 && !regServer) {
          regServer = createNetServer((client: any) => {
            regSockets.add(client);
            client.on("close", () => regSockets.delete(client));
            let buf = "";
            client.setEncoding("utf8");
            client.on("data", (d: string) => {
              for (buf += d; buf.includes("\n"); buf = buf.slice(buf.indexOf("\n") + 1)) {
                const f = JSON.parse(buf.slice(0, buf.indexOf("\n")));
                frames.push(f);
                if (f.harness) {
                  client.write(`${JSON.stringify({ status: "ok", sessionId: "svc:genie-guard" })}\n`);
                } else if (f.action === "poll") {
                  if (!delivered) {
                    delivered = true;
                    client.write(`${JSON.stringify({ action: "deliver", messageId: "01C", text: JSON.stringify(env) })}\n`);
                  } else {
                    client.write(`${JSON.stringify({ action: "timeout" })}\n`);
                  }
                } else if (f.action === "ack") {
                  client.write(`${JSON.stringify({ status: "ok" })}\n`);
                  onAck();
                } else {
                  client.write(`${JSON.stringify({ status: "ok" })}\n`);
                }
              }
            });
          });
          await new Promise<void>((r) => regServer.listen(sockPath, r));
        }
      },
      log: (line) => logs.push(line),
    });

    await acked;
    ac.abort();
    await servePromise;

    assert.ok(waits.length >= 2, `should have waited at least twice, got: ${waits.length}`);
    assert.equal(waits[0], 1000, "first backoff should be 1000ms");
    assert.equal(waits[1], 2000, "second backoff should be 2000ms");
    assert.ok(
      logs.some((l) => l.includes("waiting for xmsg") && l.includes("ENOENT")),
      `should log waiting for xmsg with ENOENT, got: ${JSON.stringify(logs)}`,
    );
    assert.deepEqual(frames.slice(0, 4).map((f) => f.action ?? f.harness), ["svc", "poll", "reply", "ack"]);
  } finally {
    ac.abort();
    x.close();
    for (const s of regSockets) s.destroy();
    if (regServer) regServer.close();
    await closeNinfer();
  }
});

// -----------------------------------------------------------------------------
// Oracle 3: A 401 from the model still exits non-zero, not retried.
// Mutant in src/guard/service.ts: retry on Unauthorized too => RED
// -----------------------------------------------------------------------------
test("oracle 3: a 401 from the model still exits non-zero and is not retried", async () => {
  const { c, x, order, close } = await modelsAt([401]);
  const waits: number[] = [];
  const logs: string[] = [];
  const ac = new AbortController();

  try {
    await assert.rejects(
      serve(c, x, system, systemWeb, {
        wait: async (ms) => {
          waits.push(ms);
          ac.abort();
        },
        log: (l) => logs.push(l),
        signal: ac.signal,
      }),
      (e) => e instanceof Unauthorized && e.message === `${c.base}: unauthorized (check --api-key-file)`,
    );
    assert.deepEqual(order, ["probe"], "should only probe once and not retry on 401");
    assert.equal(waits.length, 0, "should not wait/retry on 401");
  } finally {
    ac.abort();
    await close();
  }
});


