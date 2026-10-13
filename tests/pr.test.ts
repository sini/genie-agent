// The PR action's gating oracle (plan A3), through A1's real broker with the kind-dispatching act
// against a stub ninfer and a stub GitHub API: a pr proposal opens exactly one PR whose body links
// the thread, its calls arrive in the order src/broker/pr.ts states, and a failure at the PR step is
// not acted on, with its branch deleted and no token in the reason.
// Run with `node --test tests/pr.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { broker, byKind } from "../src/broker/index.ts";
import { gist } from "../src/broker/gist.ts";
import { pr } from "../src/broker/pr.ts";

interface Req {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
type Reply = { status: number; body: string };

const THREAD = "$root:example.org";
const link = (t: string) => `https://chat.example.org/thread/${encodeURIComponent(t)}`;
const PR_URL = "https://github.com/alice/flake/pull/7";
const GIST_URL = "https://gist.github.com/genie-bot/aa5a";

// A GitHub with alice/flake (public, default branch main) whose fork appears after one 404 poll.
// `override` answers a "METHOD /path" first; every request is recorded.
async function github(override: (r: Req) => Reply | undefined = () => undefined) {
  const requests: Req[] = [];
  let polls = 0;
  const route = (r: Req): Reply => {
    const ok = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
    switch (`${r.method} ${r.url}`) {
      case "GET /repos/alice/flake":
        return ok({ private: false, default_branch: "main" });
      case "POST /repos/alice/flake/forks":
        return ok({ full_name: "genie-bot/flake", owner: { login: "genie-bot" } }, 202);
      case "GET /repos/genie-bot/flake/git/ref/heads/main":
        return polls++ ? ok({ object: { sha: "base" } }) : ok({ message: "Not Found" }, 404);
      case "GET /repos/alice/flake/branches/main":
        return ok({ commit: { sha: "base", commit: { tree: { sha: "basetree" } } } });
      case "POST /repos/genie-bot/flake/git/trees":
        return ok({ sha: "tree" }, 201);
      case "POST /repos/genie-bot/flake/git/commits":
        return ok({ sha: "commit" }, 201);
      case "POST /repos/genie-bot/flake/git/refs":
        return ok({ ref: "refs/heads/fix" }, 201);
      case "POST /repos/alice/flake/pulls":
        return ok({ html_url: PR_URL }, 201);
      case "DELETE /repos/genie-bot/flake/git/refs/heads/fix":
        return { status: 204, body: "" };
      case "POST /gists":
        return ok({ html_url: GIST_URL }, 201);
    }
    return ok({ message: "Not Found" }, 404);
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = { method: req.method!, url: req.url!, headers: req.headers, body };
      requests.push(r);
      const out = override(r) ?? route(r);
      res.writeHead(out.status).end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

// The proposal through the broker with guard-out passing and the dispatching act at `gh`.
async function run(raw: string, gh: Awaited<ReturnType<typeof github>>, token = randomUUID()) {
  const ninfer = createServer((_req, res) =>
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdict: "pass", reason: "clean" }) } }] })),
  );
  await new Promise<void>((r) => ninfer.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(`${tmpdir()}/pr-`);
  writeFileSync(`${dir}/token`, `${token}\n`);
  try {
    const act = byKind({ gist: gist(gh.base), pr: pr(link, gh.base, { pollMs: 10 }) });
    const guard = { base: `http://127.0.0.1:${(ninfer.address() as { port: number }).port}/v1`, model: "m", system: "guard-out" };
    return { action: await broker(THREAD, raw, { tokenFile: `${dir}/token`, guard, act }), token };
  } finally {
    ninfer.close();
  }
}

const proposal = JSON.stringify({ kind: "pr", repo: "alice/flake", branch: "fix", files: { "flake.nix": "{ }\n", "lib/a.nix": "1\n" }, title: "Fix the eval", body: "Imports the module." });
const pulls = (rs: Req[]) => rs.filter((r) => r.method === "POST" && r.url === "/repos/alice/flake/pulls");

test("oracle: a pr proposal opens exactly one PR, whose body links the thread", async () => {
  const gh = await github();
  try {
    const { action, token } = await run(proposal, gh);
    assert.deepEqual(action, { thread: THREAD, acted: true, reason: "acted", redactions: [], url: PR_URL });
    const [pull, ...more] = pulls(gh.requests);
    assert.equal(more.length, 0);
    assert.deepEqual(JSON.parse(pull.body), { title: "Fix the eval", head: "genie-bot:fix", base: "main", body: `Imports the module.\n\nThread: ${link(THREAD)}` });
    assert.ok(gh.requests.every((r) => r.headers.authorization === `Bearer ${token}`));
    const tree = JSON.parse(gh.requests.find((r) => r.url.endsWith("/git/trees"))!.body);
    assert.deepEqual(tree.tree.map((e: { path: string; content: string }) => [e.path, e.content]), [["flake.nix", "{ }\n"], ["lib/a.nix", "1\n"]]);
    assert.equal(tree.base_tree, "basetree");
  } finally {
    gh.close();
  }
});

test("oracle: the GitHub calls arrive in the stated order", async () => {
  const gh = await github();
  try {
    await run(proposal, gh);
    assert.deepEqual(
      gh.requests.map((r) => `${r.method} ${r.url}`),
      [
        "GET /repos/alice/flake",
        "POST /repos/alice/flake/forks",
        "GET /repos/genie-bot/flake/git/ref/heads/main",
        "GET /repos/genie-bot/flake/git/ref/heads/main",
        "GET /repos/alice/flake/branches/main",
        "POST /repos/genie-bot/flake/git/trees",
        "POST /repos/genie-bot/flake/git/commits",
        "POST /repos/genie-bot/flake/git/refs",
        "POST /repos/alice/flake/pulls",
      ],
    );
    assert.deepEqual(JSON.parse(gh.requests[6].body), { message: "Fix the eval", tree: "tree", parents: ["base"] });
    assert.deepEqual(JSON.parse(gh.requests[7].body), { ref: "refs/heads/fix", sha: "commit" });
  } finally {
    gh.close();
  }
});

test("oracle: a failure at the PR step is not acted on, the branch is deleted, and the reason never carries the token", async () => {
  // The stub echoes the Authorization header, so the token is in the act's error message.
  const gh = await github((r) => (r.url === "/repos/alice/flake/pulls" ? { status: 422, body: JSON.stringify({ message: `refused ${r.headers.authorization}` }) } : undefined));
  try {
    const { action, token } = await run(proposal, gh);
    assert.equal(pulls(gh.requests).length, 1);
    assert.deepEqual([action.acted, action.url], [false, undefined]);
    assert.equal(action.reason, 'act failed: pr: POST /repos/alice/flake/pulls: HTTP 422: {"message":"refused Bearer [token]"} (branch deleted)');
    assert.ok(!JSON.stringify(action).includes(token));
    assert.equal(gh.requests.at(-1)!.method + " " + gh.requests.at(-1)!.url, "DELETE /repos/genie-bot/flake/git/refs/heads/fix");
  } finally {
    gh.close();
  }
});

test("oracle: the dispatching act routes a gist to the gist action and a pr to the PR action", async () => {
  const gh = await github();
  try {
    const { action } = await run(JSON.stringify({ kind: "gist", files: { "flake.nix": "{ }\n" }, title: "t", body: "" }), gh);
    assert.equal(action.url, GIST_URL);
    assert.deepEqual(gh.requests.map((r) => r.url), ["/gists"]);
  } finally {
    gh.close();
  }
  await assert.rejects(byKind({ gist: gist() } as never)({ kind: "pr", files: {}, title: "t", body: "" }, "t", THREAD), /no action for a pr proposal/);
});

test("a fork that never appears fails after the bound, without a branch or a PR", async () => {
  const gh = await github((r) => (r.url.endsWith("/git/ref/heads/main") ? { status: 404, body: "{}" } : undefined));
  try {
    const act = pr(link, gh.base, { forkWaitMs: 50, pollMs: 10 });
    await assert.rejects(act(JSON.parse(proposal), "t", THREAD), /HTTP 404/);
    const polls = gh.requests.filter((r) => r.url.endsWith("/git/ref/heads/main")).length;
    assert.ok(polls >= 2 && polls <= 6, `${polls} polls`);
    assert.ok(gh.requests.every((r) => r.method !== "POST" || r.url.endsWith("/forks")));
  } finally {
    gh.close();
  }
});

test("a private repository is refused before the fork", async () => {
  const gh = await github((r) => (r.url === "/repos/alice/flake" ? { status: 200, body: JSON.stringify({ private: true, default_branch: "main" }) } : undefined));
  try {
    await assert.rejects(pr(link, gh.base)(JSON.parse(proposal), "t", THREAD), /alice\/flake is not public/);
    assert.equal(gh.requests.length, 1);
  } finally {
    gh.close();
  }
});
