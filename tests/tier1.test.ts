// Tier 1's tool surface (plan C1) against a recording pi, a recording Host, a guard stub, stub
// HTTP servers on 127.0.0.1/127.0.0.2 and an injected resolver: no network. Run with
// `node --test tests/tier1.test.ts`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { type Host, type Pi, TOOLS, type ToolCall, tier1 } from "../src/tier1/index.ts";
import { tier1Launch, writePiModelsJson } from "../src/tier1/launch.ts";
import { errors, load } from "../src/tier1/schema.ts";
import { type GuardClient, webScreen } from "../src/supervisor/guard-client.ts";
import { type Record as PiRecord, Supervisor } from "../src/supervisor/index.ts";
import type { Envelope } from "../src/guard/verdict.ts";
import { worktreeFor } from "../src/mirror/index.ts";
import { stubModel } from "./fixtures/supervisor/stub-model.ts";

const tmp = realpathSync(mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-tier1-test-`));
const worktreeRoot = `${tmp}/worktrees`;
const root = `${worktreeRoot}/t1`;
const outside = `${tmp}/outside.txt`;

const SECRET = "secret-on-a-private-address";
const PAGE = "<html><head><style>x{}</style><script>evil()</script></head><body><h1>Title</h1><p>a &amp; b</p></body></html>";
let secretPort = 0;
let okPort = 0;
let searxPort = 0;
const servers: Server[] = [];
const searches: string[] = [];

function listen(host: string, handler: Parameters<typeof createServer>[0]): Promise<number> {
  const s = createServer(handler);
  servers.push(s);
  return new Promise((resolve) => s.listen(0, host, () => resolve((s.address() as { port: number }).port)));
}

before(async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(`${root}/inside.txt`, "inside");
  writeFileSync(outside, "outside");
  symlinkSync(outside, `${root}/link-out`);
  secretPort = await listen("127.0.0.1", (_q, r) => {
    r.writeHead(200, { "content-type": "text/plain" });
    r.end(SECRET);
  });
  okPort = await listen("127.0.0.2", (q, r) => {
    const go = (to: string) => {
      r.writeHead(302, { location: to });
      r.end();
    };
    if (q.url === "/page") {
      r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      r.end(PAGE);
    } else if (q.url === "/big") {
      r.writeHead(200, { "content-type": "text/plain" });
      r.end("x".repeat(5000));
    } else if (q.url === "/png") {
      r.writeHead(200, { "content-type": "image/png" });
      r.end("PNG");
    } else if (q.url === "/to-name") go(`http://evil.test:${secretPort}/`);
    else if (q.url === "/to-ip") go(`http://127.0.0.1:${secretPort}/`);
    else if (q.url === "/to-page") go("/page");
    else if (q.url === "/loop") go("/loop");
    else r.end();
  });
  searxPort = await listen("127.0.0.1", (q, r) => {
    searches.push(q.url ?? "");
    const results = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://e.org/${i}`, content: `S${i}` }));
    r.writeHead(200, { "content-type": "application/json" });
    r.end(JSON.stringify({ results }));
  });
});
after(() => servers.forEach((s) => s.close()));

const names: Record<string, string> = {
  "evil.test": "127.0.0.1",
  "ten.test": "10.1.2.3",
  "tail.test": "100.100.1.1",
  "mapped.test": "::ffff:127.0.0.1",
  "pod.test": "10.244.3.4",
  "ok.test": "127.0.0.2",
};
const resolver = async (h: string) => (names[h] ? [{ address: names[h], family: names[h].includes(":") ? 6 : 4 }] : []);

type Call = { tool: string; arg: unknown };

// A recording Host. Its clone is P1's worktreeFor over a git spy that only makes the directory.
function host(calls: Call[], guard: GuardClient): Host {
  const record = (tool: string) => async (arg: unknown) => {
    calls.push({ tool, arg });
    return { ok: true };
  };
  return {
    eval: record("eval"),
    recall: record("recall"),
    escalate: record("escalate"),
    reply: record("reply"),
    propose: record("propose"),
    screen: webScreen(guard),
    async clone(url) {
      calls.push({ tool: "clone", arg: url });
      return worktreeFor({ mirrorRoot: `${tmp}/mirrors`, worktreeRoot }, url, "t1", async (args) => {
        if (args[0] === "clone") mkdirSync(args[args.length - 1], { recursive: true });
        if (args.includes("worktree")) mkdirSync(args[args.length - 2], { recursive: true });
        return args.includes("rev-parse") ? "abc123\n" : "";
      });
    },
  };
}

const allow: GuardClient = { check: async (e) => ({ verdict: "allow", reason: "ok", cleaned_text: e.content.text }) };

// The extension loaded into a recording pi.
function load1(opts: { guard?: GuardClient; calls?: Call[]; cluster?: string[] } = {}) {
  const tools = new Map<string, { parameters: any; execute(id: string, p: any): Promise<any> }>();
  const handlers = new Map<string, (e?: any) => Promise<any>>();
  let active: string[] = [];
  const pi: Pi = {
    registerTool: (t) => tools.set(t.name, t),
    on: (event: string, h: any) => handlers.set(event, h),
    setActiveTools: (n) => (active = n),
  };
  tier1(
    {
      root,
      searxngUrl: `http://127.0.0.1:${searxPort}`,
      cluster: opts.cluster ?? ["10.244.0.0/16"],
      fetchMaxBytes: 1000,
      timeoutMs: 3000,
      exempt: ["127.0.0.2"],
    },
    { host: host(opts.calls ?? [], opts.guard ?? allow), resolve: resolver },
  )(pi);
  const run = async (name: string, params: unknown): Promise<string> =>
    (await tools.get(name)!.execute("id", params)).content[0].text;
  const call = async (toolName: string, input: Record<string, unknown>) => {
    const e: ToolCall = { toolName, input };
    return { result: await handlers.get("tool_call")!(e), input: e.input };
  };
  return { tools, handlers, active: () => active, run, call };
}

test("oracle: the tool list is exactly the twelve", async () => {
  const t = load1();
  await t.handlers.get("session_start")!();
  const twelve = ["clone", "escalate", "eval", "find", "grep", "ls", "propose", "read", "recall", "reply", "web_fetch", "web_search"];
  assert.deepEqual([...t.active()].sort(), twelve);
  assert.deepEqual([...t.tools.keys()].sort(), twelve.filter((n) => !["read", "grep", "find", "ls"].includes(n)));
  for (const n of ["bash", "edit", "write", "codemode", "lsp"]) assert.equal((await t.call(n, {})).result?.block, true, n);

  // Verify what real pi actually exposes over the wire when launched via tier1Launch (Amendment 1)
  const model = await stubModel();
  const agentDir = mkdtempSync(`${tmp}/pi-agent-`);
  writePiModelsJson(agentDir, { baseUrl: model.url, id: "m" });
  const events: PiRecord[] = [];
  const launch = tier1Launch({
    pi: process.env.PI ?? "pi",
    config: () => ({ root, searxngUrl: "http://127.0.0.1:1", cluster: [] }),
    args: () => ["--model", "genie/m", "--no-session"],
  });
  const s = new Supervisor(
    (th) => {
      const l = launch(th);
      return { ...l, env: { ...l.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
    },
    (_th, r) => events.push(r),
    () => host([], allow),
  );
  try {
    await s.command("t1", { type: "prompt", message: JSON.stringify({ tool: "recall", args: { query: "q" } }) });
    while (!events.some((r) => r.type === "agent_settled")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(model.requests.length >= 1, "loopback stub model must receive pi's request");
    const piExposed = (model.requests[0].tools ?? []) as { type: string; function: { name: string; parameters: any } }[];
    assert.deepEqual(piExposed.map((s) => s.function.name), [...TOOLS]);
    assert.deepEqual(piExposed.map((s) => s.function.name).sort(), twelve);
    for (const builtinName of ["read", "grep", "find", "ls"]) {
      const b = piExposed.find((s) => s.function.name === builtinName);
      assert.ok(b, `pi must expose built-in tool ${builtinName}`);
      assert.equal(b.function.parameters?.type, "object");
    }
  } finally {
    await s.shutdown();
    await model.close();
  }
});

test("pi's RPC bash command is refused", async () => {
  await assert.rejects(load1().handlers.get("user_bash")!(), /shell disabled/);
});

test("no tool parameter is a boolean (K4)", () => {
  const walk = (s: unknown): void => {
    if (typeof s !== "object" || s === null) return;
    assert.notEqual((s as any).type, "boolean");
    Object.values(s).forEach(walk);
  };
  for (const [name, t] of load1().tools) {
    walk(t.parameters);
    assert.ok(!JSON.stringify(t.parameters).includes("$ref"), name);
  }
});

test("confinement: a path inside the worktree is opened as its real path", async () => {
  const t = load1();
  const r = await t.call("read", { path: "inside.txt" });
  assert.equal(r.result, undefined);
  assert.equal(r.input.path, `${root}/inside.txt`);
  assert.equal(readFileSync(r.input.path as string, "utf8"), "inside");
  const g = await t.call("grep", { pattern: "x" });
  assert.equal(g.result, undefined);
  assert.equal(g.input.path, root);
});

test("confinement: escapes are refused", async () => {
  const t = load1();
  for (const [tool, path] of [
    ["read", "../../etc/passwd"],
    ["read", "/etc/passwd"],
    ["read", outside],
    ["read", "link-out"],
    ["ls", ".."],
    ["grep", "~"],
    ["find", "~/x"],
    ["read", "https://example.org/x"],
    ["read", "file:///etc/passwd"],
    ["read", "inside .txt"],
  ]) {
    const r = await t.call(tool, { pattern: "x", path });
    assert.equal(r.result?.block, true, `${tool} ${path}`);
    assert.match(r.result.reason, /^refused: /);
  }
});

test("clone: the worktree lands under the confinement root and is readable", async () => {
  const calls: Call[] = [];
  const t = load1({ calls });
  const out = JSON.parse(await t.run("clone", { url: "https://example.org/a/b.git" }));
  assert.equal(out.rev, "abc123");
  assert.ok(out.path.startsWith(`${root}/`));
  writeFileSync(`${out.path}/f.nix`, "{}");
  assert.equal((await t.call("read", { path: `${out.path}/f.nix` })).result, undefined);
  await assert.rejects(t.run("clone", { url: "file:///etc" }), /mirror refused/);
  assert.deepEqual(calls.map((c) => c.arg), ["https://example.org/a/b.git"]);
});

test("ssrf: an allowed address is fetched, HTML reduced to text, redirects followed", async () => {
  const t = load1();
  assert.equal(await t.run("web_fetch", { url: `http://ok.test:${okPort}/page` }), "Title\na & b");
  assert.equal(await t.run("web_fetch", { url: `http://ok.test:${okPort}/to-page` }), "Title\na & b");
  assert.match(await t.run("web_fetch", { url: `http://ok.test:${okPort}/big` }), /\[truncated at 1000 bytes\]$/);
  await assert.rejects(t.run("web_fetch", { url: `http://ok.test:${okPort}/png` }), /content type image\/png/);
  await assert.rejects(t.run("web_fetch", { url: `http://ok.test:${okPort}/loop` }), /more than 3 redirects/);
});

test("ssrf: names resolving to private, tailnet or cluster addresses are refused", async () => {
  const t = load1();
  for (const host of ["evil.test", "ten.test", "tail.test", "mapped.test", "pod.test", "127.0.0.1", "[::1]", "0.0.0.0"]) {
    await assert.rejects(t.run("web_fetch", { url: `http://${host}:${secretPort}/` }), /^Error: refused: /, host);
  }
  for (const url of ["file:///etc/passwd", "ftp://ok.test/", "gopher://ok.test/"])
    await assert.rejects(t.run("web_fetch", { url }), /refused: only http and https/, url);
});

test("ssrf: a redirect from an allowed address to a refused one is refused", async () => {
  const t = load1();
  for (const path of ["/to-name", "/to-ip"])
    await assert.rejects(t.run("web_fetch", { url: `http://ok.test:${okPort}${path}` }), /^Error: refused: /, path);
});

test("guard: web results reach the model only through a verdict", async () => {
  const seen: Envelope[] = [];
  const verdict = (v: "allow" | "rewrite" | "reject"): GuardClient => ({
    check: async (e) => {
      seen.push(e);
      return { verdict: v, reason: "r", cleaned_text: v === "rewrite" ? "CLEANED" : v === "allow" ? e.content.text : "" };
    },
  });
  const url = `http://ok.test:${okPort}/page`;
  const rejected = await load1({ guard: verdict("reject") }).run("web_fetch", { url }).catch((e: Error) => e.message);
  assert.match(rejected, /^web content withheld: the guard rejected it$/);
  assert.deepEqual(seen[0], { source: "web", history: [], content: { text: "Title\na & b" } });
  assert.equal(await load1({ guard: verdict("rewrite") }).run("web_fetch", { url }), "CLEANED");
  const timedOut: GuardClient = { check: async () => ({ unavailable: "timed out" }) };
  await assert.rejects(load1({ guard: timedOut }).run("web_fetch", { url }), /withheld: the guard is unavailable \(timed out\)/);
  const throws: GuardClient = {
    check: async () => {
      throw new Error("no reply");
    },
  };
  await assert.rejects(load1({ guard: throws }).run("web_fetch", { url }), /withheld: the guard is unavailable/);
  const junk = { check: async () => ({ verdict: "maybe" }) } as unknown as GuardClient;
  await assert.rejects(load1({ guard: junk }).run("web_fetch", { url }), /withheld: the guard's reply is not a verdict/);
  await assert.rejects(load1({ guard: verdict("reject") }).run("web_search", { query: "q" }), /withheld/);
});

test("web_search: the top five from SearXNG, as title, url and snippet", async () => {
  const out = await load1().run("web_search", { query: "den aspects" });
  assert.equal(out.split("\n\n").length, 5);
  assert.equal(out.split("\n\n")[0], "T0\nhttps://e.org/0\nS0");
  assert.equal(searches.at(-1), "/search?q=den%20aspects&format=json");
});

test("schemas: an invalid input is a tool error and the Host is not called", async () => {
  const calls: Call[] = [];
  const t = load1({ calls });
  for (const [tool, args] of [
    ["escalate", { thread_id: "t", cleaned_question: "q", draft: { answer: "a" }, eval_transcript: [], gaps: [] }],
    ["escalate", {}],
    ["eval", { repo: "o/r", rev: "main", attr: "x", trusted: false }],
    ["reply", { answer: "a", confidence: 2, gaps: [], escalate_forced: "no" }],
    ["reply", { answer: "a", confidence: 0.5, gaps: [], escalate_forced: true }],
    ["propose", { kind: "pr", files: { a: "b" }, title: "t", body: "" }],
    ["recall", { query: "" }],
  ] as const) {
    await assert.rejects(t.run(tool, args), new RegExp(`^Error: invalid ${tool} arguments: `), `${tool} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(calls, []);
  await t.run("reply", { answer: "a", confidence: 0.5, gaps: [], escalate_forced: "yes" });
  await t.run("recall", { query: "q" });
  const draft = { answer: "a", confidence: 0.5, gaps: [], escalate_forced: "no" };
  await t.run("escalate", { thread_id: "t", cleaned_question: "q", draft, eval_transcript: [], gaps: [] });
  assert.deepEqual(calls, [
    { tool: "reply", arg: { answer: "a", confidence: 0.5, gaps: [], escalate_forced: true } },
    { tool: "recall", arg: "q" },
    { tool: "escalate", arg: { thread_id: "t", cleaned_question: "q", draft: { ...draft, escalate_forced: false }, eval_transcript: [], gaps: [] } },
  ]);
});

test("schemas: the validator agrees with every fixture the tools' schemas own", () => {
  let n = 0;
  for (const name of ["draft", "eval-request", "eval-result", "escalation", "proposal"]) {
    for (const arm of ["valid", "invalid"]) {
      const dir = new URL(`../schemas/fixtures/${name}/${arm}/`, import.meta.url);
      for (const f of readdirSync(dir)) {
        const bad = errors(load(name), JSON.parse(readFileSync(new URL(f, dir), "utf8")));
        assert.equal(bad.length === 0, arm === "valid", `${name}/${arm}/${f}: ${bad.join("; ")}`);
        n++;
      }
    }
  }
  assert.ok(n >= 10, `${n} fixtures`);
});

function assertRecallBankMap(desc: string, label: string): void {
  assert.match(desc, /\bsupport\b/, `${label}: must name support bank`);
  assert.match(desc, /support memory/i, `${label}: must name support memory`);
  assert.match(desc, /curated answers/i, `${label}: must describe support bank contents`);
  assert.match(desc, /\bmemory\b/, `${label}: must name memory bank`);
  assert.match(desc, /operating memory/i, `${label}: must name operating memory`);
  assert.match(desc, /tool usage/i, `${label}: must describe operating memory tool usage`);
  assert.match(desc, /debugging techniques/i, `${label}: must describe operating memory debugging techniques`);
  assert.match(desc, /gen\/den reference/i, `${label}: must describe operating memory gen/den reference`);
  assert.match(
    desc,
    /how to do something with a tool or the gen libraries[\s\S]*recall[\s\S]*memory/i,
    `${label}: must route tool and gen library how-to questions to memory bank`,
  );
}

test("oracle (R1): recall tool description, parameter schema, and tier1 prompt name both banks and their contents", () => {
  const recallTool = load1().tools.get("recall")!;
  assert.ok(recallTool, "recall tool must be registered");
  assertRecallBankMap(recallTool.description, "recall.description");
  assertRecallBankMap(
    (recallTool.parameters as any).properties.bank.description,
    "recall.parameters.properties.bank.description",
  );
  const promptText = readFileSync(new URL("../prompts/tier1.md", import.meta.url), "utf8");
  assertRecallBankMap(promptText, "prompts/tier1.md");
});

test("mutant (R1): a recall description without the memory entry fails the R1 oracle RED", () => {
  const withoutMemoryEntry =
    'Search a memory bank: "support" (default) holds the support memory (curated answers).';
  assert.throws(
    () => assertRecallBankMap(withoutMemoryEntry, "mutant-no-memory"),
    /must name memory bank|must name operating memory/,
  );
});

