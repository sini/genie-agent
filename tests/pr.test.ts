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
import { broker, byKind, verifyBotIdentity, type Proposal } from "../src/broker/index.ts";
import { gist } from "../src/broker/gist.ts";
import { pr } from "../src/broker/pr.ts";
import { errors, load } from "../src/tier1/schema.ts";

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
async function run(raw: string, gh: Awaited<ReturnType<typeof github>>, token = randomUUID(), allowedRepos: string[] = ["alice/flake"]) {
  const ninfer = createServer((_req, res) =>
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdict: "pass", reason: "clean" }) } }] })),
  );
  await new Promise<void>((r) => ninfer.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(`${tmpdir()}/pr-`);
  writeFileSync(`${dir}/token`, `${token}\n`);
  try {
    const act = byKind({ gist: gist(gh.base), pr: pr(link, gh.base, { pollMs: 10 }) });
    const guard = { base: `http://127.0.0.1:${(ninfer.address() as { port: number }).port}/v1`, model: "m", system: "guard-out" };
    return { action: await broker(THREAD, raw, { tokenFile: `${dir}/token`, allowedRepos, guard, act }), token };
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

test("oracle GX1 (F4): repo coordinate, branch ref, file paths, and commits validated in schemas/proposal.json, broker, and pr sink", async () => {
  const schema = load("proposal");
  const gh = await github();
  try {
    // Positive control: valid proposal passes schema, broker, and pr(), reaching GitHub API.
    const validObj: Proposal = {
      kind: "pr",
      repo: "alice/flake",
      branch: "fix",
      commits: ["0123456789abcdef0123456789abcdef01234567"],
      files: { "flake.nix": "{ }\n" },
      title: "Fix the eval",
      body: "Imports the module.",
    };
    assert.deepEqual(errors(schema, validObj), []);
    const { action: okAction } = await run(JSON.stringify(validObj), gh);
    assert.equal(okAction.acted, true);
    assert.equal(okAction.url, PR_URL);

    // Malicious proposals (path traversal "..", leading "-", extra/disallowed "/" in repo, ".lock" in branch,
    // empty files/commits, traversal in file path) are refused at schema/broker boundary AND at the pr() sink
    // before any HTTP request is made to GitHub.
    const badProposals: { label: string; p: Proposal; checkSchema: boolean }[] = [
      {
        label: "repo with .. traversal",
        p: { ...validObj, repo: "alice/../victim" },
        checkSchema: true,
      },
      {
        label: "repo with leading dash",
        p: { ...validObj, repo: "-alice/flake" },
        checkSchema: true,
      },
      {
        label: "repo with extra slash",
        p: { ...validObj, repo: "alice/flake/extra" },
        checkSchema: true,
      },
      {
        label: "branch with ..",
        p: { ...validObj, branch: "feat..evil" },
        checkSchema: true,
      },
      {
        label: "branch with ../ traversal",
        p: { ...validObj, branch: "../heads/main" },
        checkSchema: true,
      },
      {
        label: "branch with leading dash",
        p: { ...validObj, branch: "-upload-pack=evil" },
        checkSchema: true,
      },
      {
        label: "branch ending in .lock",
        p: { ...validObj, branch: "feat/test.lock" },
        checkSchema: false,
      },
      {
        label: "empty commits array",
        p: { ...validObj, commits: [] },
        checkSchema: true,
      },
      {
        label: "file path with ..",
        p: { ...validObj, files: { "../etc/passwd": "x" } },
        checkSchema: false,
      },
      {
        label: "file path with leading slash",
        p: { ...validObj, files: { "/etc/passwd": "x" } },
        checkSchema: false,
      },
      {
        label: "file path with leading dash",
        p: { ...validObj, files: { "-n": "x" } },
        checkSchema: false,
      },
    ];

    const actSink = pr(link, gh.base, { pollMs: 10 });
    for (const { label, p, checkSchema } of badProposals) {
      const reqsBefore = gh.requests.length;
      if (checkSchema) {
        assert.ok(errors(schema, p).length > 0, `schema must refuse ${label}`);
      }
      const { action } = await run(JSON.stringify(p), gh);
      assert.equal(action.acted, false, `broker must refuse ${label}`);
      assert.match(action.reason, /^not a proposal:/, `broker reason for ${label}: ${action.reason}`);
      assert.equal(gh.requests.length, reqsBefore, `broker must make 0 GitHub requests for ${label}`);

      // Direct sink call on pr() without broker upstream:
      await assert.rejects(
        actSink(p, "tok-unused", THREAD),
        /pr:/,
        `pr() sink must refuse ${label} directly`,
      );
      assert.equal(gh.requests.length, reqsBefore, `pr() sink must make 0 GitHub requests for ${label}`);
    }
  } finally {
    gh.close();
  }
});

test("oracle O-GC1-pr-f6: publishPr and verifyBotIdentity enforce botLogin, forbiddenLogins, public-only, non-self upstream owner, Q1 permissions object, read-only upstream permissions, fork owner/full_name, and headOwner:branch ref, with zero write calls on refusal", async () => {
  let userLogin: unknown = "genie-bot";
  let userStatus = 200;
  let repoBody: Record<string, unknown> = {
    private: false,
    owner: { login: "alice" },
    default_branch: "main",
    permissions: { push: false, maintain: false, admin: false },
  };
  let forkBody: Record<string, unknown> = {
    full_name: "genie-bot/flake",
    owner: { login: "Genie-Bot" },
  };

  const gh = await github((r) => {
    if (r.method === "GET" && r.url === "/user") {
      return { status: userStatus, body: JSON.stringify({ login: userLogin }) };
    }
    if (r.method === "GET" && r.url === "/repos/alice/flake") {
      return { status: 200, body: JSON.stringify(repoBody) };
    }
    if (r.method === "POST" && r.url === "/repos/alice/flake/forks") {
      return { status: 202, body: JSON.stringify(forkBody) };
    }
    return undefined;
  });

  const writeReqs = () => gh.requests.filter((r) => r.method !== "GET");
  const gitWriteReqs = () =>
    gh.requests.filter(
      (r) => r.method !== "GET" && !(r.method === "POST" && r.url === "/repos/alice/flake/forks"),
    );

  try {
    const pObj: Proposal = JSON.parse(proposal);
    const runPr = (botLogin = "genie-bot", forbiddenLogins: string[] = ["sini"]) =>
      pr(link, gh.base, { pollMs: 10, forkWaitMs: 200, botLogin, forbiddenLogins })(pObj, "tok-f6", THREAD);

    // 1. upstream.owner.login == botLogin (exact and case-insensitive) refused before any fork or push call (0 write requests)
    for (const selfOwner of ["genie-bot", "Genie-Bot"]) {
      gh.requests.length = 0;
      repoBody = {
        private: false,
        owner: { login: selfOwner },
        default_branch: "main",
        permissions: { push: false, maintain: false, admin: false },
      };
      await assert.rejects(runPr(), /upstream repo alice\/flake is owned by genie-bot/);
      assert.equal(writeReqs().length, 0, `self-owned upstream (${selfOwner}) must make 0 write requests`);
    }

    // 2. upstream.private !== false (true and undefined) refused before any fork or push call (0 write requests)
    for (const priv of [true, undefined]) {
      gh.requests.length = 0;
      repoBody = {
        private: priv,
        owner: { login: "alice" },
        default_branch: "main",
        permissions: { push: false, maintain: false, admin: false },
      };
      await assert.rejects(runPr(), /alice\/flake is not public/);
      assert.equal(writeReqs().length, 0, `non-public upstream (private=${String(priv)}) must make 0 write requests`);
    }

    // 3. Gate v1 Q1: upstream.permissions absent (undefined), null, or non-object refused before any fork or push call (0 write requests)
    for (const badPerms of [undefined, null, "read"]) {
      gh.requests.length = 0;
      repoBody = {
        private: false,
        owner: { login: "alice" },
        default_branch: "main",
        permissions: badPerms,
      };
      await assert.rejects(runPr(), /missing permissions object/);
      assert.equal(writeReqs().length, 0, `upstream with permissions=${String(badPerms)} must make 0 write requests`);
    }

    // 4. upstream.permissions.{push,maintain,admin} === true refused before any fork or push call (0 write requests)
    for (const writePerm of [
      { push: true, maintain: false, admin: false },
      { push: false, maintain: true, admin: false },
      { push: false, maintain: false, admin: true },
    ]) {
      gh.requests.length = 0;
      repoBody = {
        private: false,
        owner: { login: "alice" },
        default_branch: "main",
        permissions: writePerm,
      };
      await assert.rejects(runPr(), /token has write permission on upstream repo/);
      assert.equal(writeReqs().length, 0, `upstream with ${JSON.stringify(writePerm)} must make 0 write requests`);
    }

    // Restore valid upstream repoBody for fork / identity / head-ref checks
    repoBody = {
      private: false,
      owner: { login: "alice" },
      default_branch: "main",
      permissions: { push: false, maintain: false, admin: false },
    };

    // 5. fork.owner.login != botLogin (and missing fork.owner) refused with 0 git write requests
    for (const badForkOwner of ["sini", "alice", undefined]) {
      gh.requests.length = 0;
      forkBody = { full_name: "genie-bot/flake", owner: badForkOwner ? { login: badForkOwner } : undefined };
      await assert.rejects(runPr(), /fork owner .* does not match genie-bot/);
      assert.equal(gitWriteReqs().length, 0, `fork owner ${String(badForkOwner)} must make 0 git/PR write requests`);
    }

    // 6. fork.full_name == p.repo (exact and case-insensitive) or invalid coordinate refused with 0 git write requests
    for (const sameName of ["alice/flake", "Alice/Flake"]) {
      gh.requests.length = 0;
      forkBody = { full_name: sameName, owner: { login: "genie-bot" } };
      await assert.rejects(runPr(), /fork full_name .* matches upstream repo/);
      assert.equal(gitWriteReqs().length, 0, `fork full_name ${sameName} must make 0 git/PR write requests`);
    }
    gh.requests.length = 0;
    forkBody = { full_name: "invalid-coord", owner: { login: "genie-bot" } };
    await assert.rejects(runPr(), /invalid fork full_name/);
    assert.equal(gitWriteReqs().length, 0);
    forkBody = { full_name: "genie-bot/flake", owner: { login: "Genie-Bot" } };

    // 6b. Invalid upstream default_branch refused before any fork call (0 write requests)
    gh.requests.length = 0;
    repoBody = {
      private: false,
      owner: { login: "alice" },
      default_branch: "../bad",
      permissions: { push: false, maintain: false, admin: false },
    };
    await assert.rejects(runPr(), /invalid upstream default_branch/);
    assert.equal(writeReqs().length, 0);
    repoBody = {
      private: false,
      owner: { login: "alice" },
      default_branch: "main",
      permissions: { push: false, maintain: false, admin: false },
    };

    // 7a. verifyBotIdentity: configured botLogin in forbiddenLogins refused before GET /user (0 HTTP requests)
    gh.requests.length = 0;
    userLogin = "Sini";
    await assert.rejects(runPr("Sini", ["sini"]), /broker\.botLogin Sini is in forbiddenLogins/);
    assert.equal(gh.requests.length, 0, "forbidden configured botLogin must make 0 HTTP requests");

    // 7b. verifyBotIdentity: /user.login in forbiddenLogins refused before any repo/write call (0 write requests)
    gh.requests.length = 0;
    userLogin = "sini";
    await assert.rejects(runPr("genie-bot", ["sini"]), /broker token identity forbidden: sini/);
    assert.equal(writeReqs().length, 0, "forbidden /user login must make 0 write requests");

    // 8. verifyBotIdentity: login !== botLogin refused when login ("alice") is not in forbiddenLogins (["sini"])
    gh.requests.length = 0;
    userLogin = "alice";
    await assert.rejects(runPr("genie-bot", ["sini"]), /mismatch: expected genie-bot, got alice/);
    assert.equal(writeReqs().length, 0, "botLogin mismatch must make 0 write requests");

    // 9. verifyBotIdentity: invalid botLogin syntax and empty /user.login refused
    gh.requests.length = 0;
    await assert.rejects(verifyBotIdentity(gh.base, "tok", "-bad-login", []), /invalid broker\.botLogin/);
    assert.equal(gh.requests.length, 0);
    userLogin = "";
    await assert.rejects(runPr("genie-bot", ["sini"]), /missing login/);
    assert.equal(writeReqs().length, 0);

    // 10. Positive control + head-ref construction: when userLogin="Genie-Bot" and fork.owner.login="Genie-Bot"
    // with configured botLogin="genie-bot", PR succeeds and POST /pulls sends head: "genie-bot:fix"
    gh.requests.length = 0;
    userLogin = "Genie-Bot";
    const ok = await runPr("genie-bot", ["sini"]);
    assert.equal(ok.url, PR_URL);
    const [pullReq] = pulls(gh.requests);
    assert.ok(pullReq, "positive control must POST /repos/alice/flake/pulls");
    assert.equal(JSON.parse(pullReq.body).head, "genie-bot:fix");
  } finally {
    gh.close();
  }
});


