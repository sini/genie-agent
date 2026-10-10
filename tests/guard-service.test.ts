// genie-guard's gating oracle (genie-solicit-design.md, G1), against a mock ninfer and an xmsg
// fake: a model verdict is relayed as the parsed verdict, never the model's text; a malformed
// model reply is a reject; no review (ninfer down, an HTTP error, a timeout) and a message that is
// not an envelope are `{"error": …}`, never a verdict. Run with `node --test tests/guard-service.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Inbound } from "../src/dispatcher/xmsg.ts";
import { config, ConfigError } from "../src/guard/config.ts";
import { firstModel, type Ninfer, start, step, Unauthorized } from "../src/guard/service.ts";
import { type Envelope, PARSE_FAILURE } from "../src/guard/verdict.ts";

const system = "the guard prompt";
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
  const n: Ninfer = { base: `http://127.0.0.1:${port}/v1`, model: "m", system, timeoutMs: 300 };
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
        max_tokens: 8192,
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

const notEnvelopes: [string, string][] = [
  ["unparseable", "hello genie"],
  ["an array", "[]"],
  ["a missing content", JSON.stringify({ source: "message", history: [] })],
  ["an unknown source", JSON.stringify({ ...env, source: "web" })],
  ["an unknown key", JSON.stringify({ ...env, trusted: true })],
  ["a line tier outside trusted|public", JSON.stringify({ ...env, history: [{ ...env.history[0], tier: "owner" }] })],
  ["a message with no tier", JSON.stringify({ ...env, content: { sender: "@b:example.org", text: "hi" } })],
  ["eval output with a sender", JSON.stringify({ ...env, source: "eval_stdout", content: env.content })],
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

test("eval output and recall envelopes, which carry no sender, reach the model", async () => {
  for (const source of ["eval_stdout", "recall"] as const) {
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
    const n = await start(c, x, system, async (ms) => void waits.push(ms), () => {});
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
    await start(c, x, system, async (ms) => void waits.push(ms), () => {});
    assert.deepEqual(waits, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  } finally {
    await close();
  }
});

test("register is called only after the model probe succeeds", { timeout: 5000 }, async () => {
  const { c, x, order, close } = await modelsAt([503, 200]);
  try {
    await start(c, x, system, quiet.sleep, quiet.log);
    assert.ok(order.indexOf("register") > order.lastIndexOf("probe"), order.join());
    assert.equal(order.filter((o) => o === "register").length, 1);
  } finally {
    await close();
  }
});

test("a 401 or 403 at start is Unauthorized, not retried, and the guard never registers", { timeout: 5000 }, async () => {
  for (const code of [401, 403]) {
    const { c, x, order, close } = await modelsAt([code]);
    try {
      await assert.rejects(start(c, x, system, quiet.sleep, quiet.log), (e) => e instanceof Unauthorized && e.message === `${c.base}: unauthorized (check --api-key-file)`);
      assert.deepEqual(order, ["probe"]);
    } finally {
      await close();
    }
  }
});
