// The broker's gating oracle (design oracle 7), against a stub ninfer and a recording act: a
// proposal that fails guard-out, for any reason, is never acted on; a passing one is acted on once,
// with its credentials redacted; and the token reaches the act and nothing else.
// Run with `node --test tests/broker.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { broker, byKind, computeWorktreeDiff, type Proposal } from "../src/broker/index.ts";
import { gist as gistAct } from "../src/broker/gist.ts";
import { pr as prAct } from "../src/broker/pr.ts";
import { git, mirrorKey, worktreeFor, type MirrorConfig, type Runner } from "../src/mirror/index.ts";
import { tier1, type Host, type Pi, type ToolCall } from "../src/tier1/index.ts";

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

test("oracle (G11): when guardOut.enable is false, the deterministic redactor still runs and guard-out receives 0 calls", async () => {
  const cred = credential();
  const raw = JSON.stringify({
    kind: "pr",
    repo: "alice/nix-config",
    branch: "genie/fix-foo",
    files: { "hosts/laptop.nix": `{ token = "${cred}"; }\n` },
    title: `Enable foo ${cred}`,
    body: `Thread: https://matrix.to/#/!abc:example.org\n${cred}`,
  });

  // On-mode allow baseline
  const onRun = await run(verdict("pass", "clean"), raw);
  assert.equal(onRun.requests.length, 1);

  // Off-mode against a stub ninfer that would return 500 if called
  const n = await ninfer("should not be called", 500);
  const { act, calls } = recordingAct();
  try {
    const offAction = await broker("!t:example.org", raw, {
      tokenFile: tokenFile(randomUUID()),
      guard: { enable: false, base: n.base, model: "m", system: "guard-out" },
      act,
    });
    assert.equal(n.requests.length, 0, "guard-out must receive 0 calls when enable is false");
    assert.equal(calls.length, 1);
    assert.deepEqual(offAction, onRun.action, "off-mode action must match on-mode allow action including redactions");
    const sent = JSON.stringify(calls[0].p);
    assert.ok(!sent.includes(cred), "credential must be redacted even when guard-out is off");
    assert.deepEqual(calls[0].p, onRun.calls[0].p, "off-mode redacted proposal must equal on-mode allow proposal");
  } finally {
    n.close();
  }
});

test("oracle O-GC1-propose: ls-tree + cat-file --batch worktree extraction (C1 / F2), subdirectory computeWorktreeDiff (C-N4), confineWrite + write-delta quota (F5 / F9), genie-bot identity & fork enforcement (F6 / Q1), and all four mutants go RED", async () => {
  const rootTmp = realpathSync(mkdtempSync(`${tmpdir()}/genie-gc1-propose-`));
  const served = `${rootTmp}/served`;
  mkdirSync(`${served}/alice`, { recursive: true });
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const sh = (args: string[], cwd = rootTmp) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: gitEnv, encoding: "utf8" }).trim();

  // Start a local git daemon serving served/alice/c1repo.git
  const gitPort = await new Promise<number>((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  sh(["init", "-q", "--bare", "-b", "main", `${served}/alice/c1repo.git`]);
  const work = `${rootTmp}/work-c1repo`;
  sh(["clone", "-q", `${served}/alice/c1repo.git`, work]);

  // Populate all 5 Gate v1 C1 (B) attributes in alice/c1repo:
  // 1) 120000 symlink `link -> /etc/passwd`
  // 2) .gitattributes with export-ignore, export-subst, and text eol=crlf
  // 3) ignored.txt, subst.txt ($Format:%H$), lf.txt (LF lines)
  // 4) 160000 gitlink `sub`
  // 5) root.nix and subpkg/a.nix (for C-N4 subdirectory propose)
  symlinkSync("/etc/passwd", `${work}/link`);
  writeFileSync(
    `${work}/.gitattributes`,
    "ignored.txt export-ignore\nsubst.txt export-subst\nlf.txt text eol=crlf\n",
  );
  writeFileSync(`${work}/ignored.txt`, "keep-me-despite-export-ignore\n");
  writeFileSync(`${work}/subst.txt`, "$Format:%H$\n");
  writeFileSync(`${work}/lf.txt`, "line1\nline2\n");
  writeFileSync(`${work}/root.nix`, "{ root = true; }\n");
  mkdirSync(`${work}/subpkg`, { recursive: true });
  writeFileSync(`${work}/subpkg/a.nix`, "{ a = 1; }\n");
  sh(["add", "link", ".gitattributes", "ignored.txt", "subst.txt", "lf.txt", "root.nix", "subpkg/a.nix"], work);
  const subSha = "1111111111111111111111111111111111111111";
  sh(["update-index", "--add", "--cacheinfo", `160000,${subSha},sub`], work);
  sh(["commit", "-q", "-m", "c1 fixture with symlink, gitattributes, gitlink, and subpkg"], work);
  sh(["push", "-q", "origin", "HEAD:main"], work);

  const daemon = spawn(
    "git",
    ["daemon", "--export-all", "--reuseaddr", "--listen=127.0.0.1", `--port=${gitPort}`, `--base-path=${served}`, served],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const gitBase = `https://127.0.0.1:${gitPort}`;
  for (let i = 0; ; i++) {
    try {
      sh(["ls-remote", `git://127.0.0.1:${gitPort}/alice/c1repo`]);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const mirrorCfg: MirrorConfig = {
    mirrorRoot: `${rootTmp}/mirrors`,
    worktreeRoot: `${rootTmp}/worktrees`,
    exempt: ["127.0.0.1"],
  };
  const runGit: Runner = (args, signal) =>
    git(
      ["-c", "protocol.git.allow=always", ...args.map((a) => a.replace(/^https:\/\/127\.0\.0\.1:/i, "git://127.0.0.1:"))],
      signal,
    );

  const nPass = await ninfer(verdict("pass", "clean"));
  const nBlock = await ninfer(verdict("block", "leak"));

  // Configurable stub GitHub API server for F6 / Q1
  let ghLogin = "genie-bot";
  let ghRepoPermissions: Record<string, boolean> | undefined = { push: false, maintain: false, admin: false };
  let ghRepoOwner = "alice";
  let ghForkOwner = "genie-bot";
  const ghCalls: { method: string; url: string; body: any }[] = [];
  const ghServer = createServer((req, res) => {
    let rawBody = "";
    req.on("data", (c) => (rawBody += c));
    req.on("end", () => {
      const parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
      ghCalls.push({ method: req.method!, url: req.url!, body: parsedBody });
      const ok = (data: unknown, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      switch (`${req.method} ${req.url}`) {
        case "GET /user":
          return ok({ login: ghLogin });
        case "POST /gists":
          return ok({ html_url: "https://gist.github.com/genie-bot/1" }, 201);
        case "GET /repos/alice/c1repo":
          return ok({
            private: false,
            default_branch: "main",
            owner: { login: ghRepoOwner },
            ...(ghRepoPermissions !== undefined ? { permissions: ghRepoPermissions } : {}),
          });
        case "POST /repos/alice/c1repo/forks":
          return ok({ full_name: `${ghForkOwner}/c1repo`, owner: { login: ghForkOwner } }, 202);
        case "GET /repos/genie-bot/c1repo/git/ref/heads/main":
          return ok({ object: { sha: "basecommit" } });
        case "GET /repos/alice/c1repo/branches/main":
          return ok({ commit: { sha: "basecommit", commit: { tree: { sha: "basetree" } } } });
        case "POST /repos/genie-bot/c1repo/git/trees":
          return ok({ sha: "newtree" }, 201);
        case "POST /repos/genie-bot/c1repo/git/commits":
          return ok({ sha: "newcommit" }, 201);
        case "POST /repos/genie-bot/c1repo/git/refs":
          return ok({ ref: parsedBody?.ref ?? "refs/heads/fix" }, 201);
        case "POST /repos/alice/c1repo/pulls":
          return ok({ html_url: "https://github.com/alice/c1repo/pull/99" }, 201);
        default:
          res.writeHead(404).end(JSON.stringify({ message: "Not Found" }));
      }
    });
  });
  await new Promise<void>((r) => ghServer.listen(0, "127.0.0.1", r));
  const ghApi = `http://127.0.0.1:${(ghServer.address() as { port: number }).port}`;

  try {
    // =========================================================================
    // 1. F2 & Gate v1 C1 (N2/N3): ls-tree + cat-file --batch worktree extraction
    // =========================================================================
    const repoUrl = `${gitBase}/alice/c1repo`;
    const key = mirrorKey(repoUrl);
    const wt = await worktreeFor(mirrorCfg, repoUrl, "th-c1", runGit);
    assert.equal(existsSync(`${wt.path}/.git`), false, "writable worktree must contain zero .git metadata (F2)");
    const linkSt = lstatSync(`${wt.path}/link`);
    assert.equal(linkSt.isSymbolicLink(), false, "120000 symlink must not materialize as S_IFLNK (C1 / N2)");
    assert.equal(linkSt.isFile(), true, "120000 symlink must materialize as regular file (C1 / N2)");
    assert.equal(readFileSync(`${wt.path}/link`, "utf8"), "/etc/passwd");
    assert.equal(existsSync(`${wt.path}/ignored.txt`), true, "export-ignore file must still be extracted (C1 / N3)");
    assert.equal(readFileSync(`${wt.path}/subst.txt`, "utf8"), "$Format:%H$\n", "export-subst must not expand (C1 / N3)");
    assert.equal(readFileSync(`${wt.path}/lf.txt`, "utf8"), "line1\nline2\n", "eol=crlf must not convert LF to CRLF (C1 / N3)");
    assert.equal(existsSync(`${wt.path}/sub`), false, "160000 gitlink must be skipped without creating an empty dir (C1 / N3)");

    // Untouched checkout has zero phantom diffs in computeWorktreeDiff!
    const untouchedDiff = await computeWorktreeDiff({
      mirrorRoot: mirrorCfg.mirrorRoot,
      worktreeRoot: mirrorCfg.worktreeRoot,
      thread: "th-c1",
      repo: "alice/c1repo",
      worktreeSubdir: key,
      repoUrlBase: gitBase,
    });
    assert.deepEqual(untouchedDiff.entries, [], "untouched checkout must produce 0 phantom diff entries (C1 / N3)");

    // Plant malicious .git (`gitdir: ./evil`) and `evil/config` (`core.fsmonitor = "touch <marker>"`)
    const markerFile = `${rootTmp}/fsmonitor-pwned`;
    mkdirSync(`${wt.path}/evil`, { recursive: true });
    writeFileSync(`${wt.path}/.git`, "gitdir: ./evil\n");
    writeFileSync(`${wt.path}/evil/config`, `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = touch ${markerFile}\n`);
    const afterEvilGitDiff = await computeWorktreeDiff({
      mirrorRoot: mirrorCfg.mirrorRoot,
      worktreeRoot: mirrorCfg.worktreeRoot,
      thread: "th-c1",
      repo: "alice/c1repo",
      worktreeSubdir: key,
      repoUrlBase: gitBase,
    });
    // Only `evil/config` is seen as a regular file; `.git` is ignored and git is never spawned in wt.path
    assert.equal(existsSync(markerFile), false, "computeWorktreeDiff must never trigger core.fsmonitor");
    assert.ok(!afterEvilGitDiff.entries.some((e) => e.path === ".git" || e.path.startsWith(".git/")));
    rmSync(`${wt.path}/evil`, { recursive: true, force: true });
    rmSync(`${wt.path}/.git`, { force: true });

    // Re-running worktreeFor replaces wt.path cleanly without running git inside wt.path
    await worktreeFor(mirrorCfg, repoUrl, "th-c1", runGit);
    assert.equal(existsSync(markerFile), false, "re-running worktreeFor must never trigger core.fsmonitor");

    // =========================================================================
    // 2. Gate v1 C-N4: subdirectory worktreeSubdir & cross-repo mismatch refusal
    // =========================================================================
    writeFileSync(`${wt.path}/subpkg/a.nix`, "{ a = 2; }\n");
    const subpkgDiff = await computeWorktreeDiff({
      mirrorRoot: mirrorCfg.mirrorRoot,
      worktreeRoot: mirrorCfg.worktreeRoot,
      thread: "th-c1",
      repo: "alice/c1repo",
      worktreeSubdir: `${key}/subpkg`,
      repoUrlBase: gitBase,
    });
    assert.deepEqual(
      subpkgDiff.entries,
      [{ path: "subpkg/a.nix", mode: "100644", type: "blob", content: "{ a = 2; }\n" }],
      "subdirectory worktreeSubdir must emit ONLY the edited file in subpkg/ and never delete root files (C-N4)",
    );

    // Cross-repo worktreeSubdir mismatch (repo: "other/repo" with worktreeSubdir for "alice/c1repo") is refused
    await assert.rejects(
      computeWorktreeDiff({
        mirrorRoot: mirrorCfg.mirrorRoot,
        worktreeRoot: mirrorCfg.worktreeRoot,
        thread: "th-c1",
        repo: "other/repo",
        worktreeSubdir: key,
        repoUrlBase: gitBase,
      }),
      /worktreeSubdir first segment must match the cloned mirror key/,
      "cross-repo worktreeSubdir must be refused (C-N4)",
    );

    // =========================================================================
    // 3. F5 & F9: confineWrite + write-delta quota in src/tier1/index.ts
    // =========================================================================
    const t1Root = `${mirrorCfg.worktreeRoot}/th-quota`;
    const memRoot = `${rootTmp}/memory`;
    mkdirSync(`${t1Root}/big-repo`, { recursive: true });
    mkdirSync(memRoot, { recursive: true });
    writeFileSync(`${memRoot}/MEMORY.md`, "# Operating Memory\n");
    // Pre-populate > 4,096 files (4,100 files) in the worktree to simulate a large cloned repository
    for (let i = 0; i < 4100; i++) {
      writeFileSync(`${t1Root}/big-repo/f-${i}.txt`, "x");
    }
    const stubHost: Host = {
      eval: async () => ({}),
      recall: async () => ({}),
      escalate: async () => ({}),
      reply: async () => ({}),
      propose: async () => ({}),
      clone: async () => ({ path: t1Root, rev: "0" }),
      git: async () => "",
      gh_read: async () => ({}),
      screen: async (x) => x,
      room_context: async () => "",
    };
    const makeHook = (maxScratchFiles?: number, maxScratchBytes?: number) => {
      let hook: ((e: ToolCall) => Promise<{ block: true; reason: string } | void>) | undefined;
      const pi: Pi = {
        registerTool: () => {},
        on: (ev, h) => {
          if (ev === "tool_call") hook = h;
        },
        setActiveTools: () => {},
      };
      tier1(
        {
          root: t1Root,
          memoryRoot: memRoot,
          searxngUrl: "http://127.0.0.1:1",
          cluster: [],
          maxScratchFiles,
          maxScratchBytes,
        },
        { host: stubHost },
      )(pi);
      return async (toolName: string, input: Record<string, unknown>) => {
        const e: ToolCall = { toolName, input };
        return { res: await hook!(e), input: e.input };
      };
    };

    const callHook = makeHook(2, 64);
    // Writing a new file in a worktree that already has 4,100 cloned files succeeds (F9 write-delta accounting)!
    const w1 = await callHook("write", { path: "repro/flake.nix", content: "{ a = 1; }\n" });
    assert.equal(w1.res, undefined, `write to new file must succeed despite 4,100 pre-existing cloned files: ${JSON.stringify(w1.res)}`);
    assert.equal(w1.input.path, `${t1Root}/repro/flake.nix`);
    mkdirSync(`${t1Root}/repro`, { recursive: true });
    writeFileSync(w1.input.path as string, "{ a = 1; }\n");

    // Editing that file succeeds
    const e1 = await callHook("edit", { path: "repro/flake.nix", oldText: "1", newText: "2" });
    assert.equal(e1.res, undefined);

    // Writing a 2nd new file succeeds (at maxScratchFiles = 2), but a 3rd distinct file is refused by quota
    const w2 = await callHook("write", { path: "repro/second.nix", content: "{}\n" });
    assert.equal(w2.res, undefined);
    const w3 = await callHook("write", { path: "repro/third.nix", content: "{}\n" });
    assert.equal(w3.res?.block, true, "3rd distinct written file must be blocked by maxScratchFiles=2");
    assert.match(w3.res?.reason ?? "", /scratch file quota \(2 files\) exceeded/);

    // Exceeding maxScratchBytes (64 bytes) is refused
    const wBig = await callHook("write", { path: "repro/flake.nix", content: "x".repeat(100) });
    assert.equal(wBig.res?.block, true, "write exceeding maxScratchBytes=64 must be blocked");
    assert.match(wBig.res?.reason ?? "", /scratch byte quota \(64 bytes\) exceeded/);

    // Writing or editing `/memory/MEMORY.md` or `../th-c1/root.nix` is blocked at the tool_call hook before any syscall
    for (const badPath of [`${memRoot}/MEMORY.md`, "/memory/MEMORY.md", "../th-c1/root.nix"]) {
      const wBad = await callHook("write", { path: badPath, content: "pwn" });
      assert.equal(wBad.res?.block, true, `write to ${badPath} must be blocked by confineWrite`);
      const eBad = await callHook("edit", { path: badPath, oldText: "a", newText: "b" });
      assert.equal(eBad.res?.block, true, `edit to ${badPath} must be blocked by confineWrite`);
    }

    // =========================================================================
    // 4. F6 & Q1: genie-bot identity & fork enforcement + guard-out enforcement
    // =========================================================================
    // In th-c1's worktree, modify root.nix, add added.nix, and delete ignored.txt
    writeFileSync(`${wt.path}/root.nix`, "{ root = false; }\n");
    writeFileSync(`${wt.path}/added.nix`, "{ added = 1; }\n");
    unlinkSync(`${wt.path}/ignored.txt`);

    const prRaw = JSON.stringify({
      kind: "pr",
      repo: "alice/c1repo",
      branch: "genie/multi-file-fix",
      worktreeSubdir: key,
      title: "Fix root and subpkg",
      body: "Multi-file worktreeSubdir proposal",
    });

    const realAct = byKind({
      gist: gistAct(ghApi),
      pr: prAct((th) => `https://chat.example.org/thread/${th}`, ghApi, {
        botLogin: "genie-bot",
        forbiddenLogins: ["sini"],
        pollMs: 10,
        forkWaitMs: 1000,
      }),
    });

    const runBroker = (guardBase: string) =>
      broker("th-c1", prRaw, {
        tokenFile: tokenFile("bot-secret-token"),
        botLogin: "genie-bot",
        forbiddenLogins: ["sini"],
        githubApi: ghApi,
        mirrorRoot: mirrorCfg.mirrorRoot,
        worktreeRoot: mirrorCfg.worktreeRoot,
        repoUrlBase: gitBase,
        guard: { base: guardBase, model: "m", system: "guard-out" },
        act: realAct,
      });

    // (a) Token whose GET /user returns owner identity "sini" is refused with 0 POST /pulls or POST /gists
    ghLogin = "sini";
    ghCalls.length = 0;
    const ownerRes = await runBroker(nPass.base);
    assert.equal(ownerRes.acted, false);
    assert.match(ownerRes.reason, /forbidden|mismatch/);
    assert.equal(ghCalls.filter((c) => c.method === "POST").length, 0, "owner token must make 0 POST calls");

    // (b) Gate v1 Q1: upstream repo response missing `permissions` object is refused fail-closed
    ghLogin = "genie-bot";
    ghRepoPermissions = undefined;
    ghCalls.length = 0;
    const noPermsRes = await runBroker(nPass.base);
    assert.equal(noPermsRes.acted, false);
    assert.match(noPermsRes.reason, /missing permissions object/);
    assert.equal(ghCalls.filter((c) => c.url.endsWith("/pulls")).length, 0);

    // (c) Upstream repo where token has `permissions: { push: true }` is refused
    ghRepoPermissions = { push: true, maintain: false, admin: false };
    ghCalls.length = 0;
    const pushPermsRes = await runBroker(nPass.base);
    assert.equal(pushPermsRes.acted, false);
    assert.match(pushPermsRes.reason, /write permission on upstream repo/);
    assert.equal(ghCalls.filter((c) => c.url.endsWith("/pulls")).length, 0);

    // (d) Fork response returning owner: { login: "sini" } is refused
    ghRepoPermissions = { push: false, maintain: false, admin: false };
    ghForkOwner = "sini";
    ghCalls.length = 0;
    const badForkRes = await runBroker(nPass.base);
    assert.equal(badForkRes.acted, false);
    assert.match(badForkRes.reason, /fork owner .* does not match genie-bot/);
    assert.equal(ghCalls.filter((c) => c.url.endsWith("/pulls")).length, 0);

    // (e) Positive control: GET /user === "genie-bot", permissions.push === false, fork === "genie-bot/c1repo"
    // succeeds (`acted: true`) and commits modified, added, and deleted (`sha: null`) files in one tree commit!
    ghForkOwner = "genie-bot";
    ghCalls.length = 0;
    const okRes = await runBroker(nPass.base);
    assert.equal(okRes.acted, true, `expected acted: true, got ${JSON.stringify(okRes)}`);
    assert.equal(okRes.url, "https://github.com/alice/c1repo/pull/99");
    const treeCall = ghCalls.find((c) => c.method === "POST" && c.url === "/repos/genie-bot/c1repo/git/trees");
    assert.ok(treeCall, "must POST /repos/genie-bot/c1repo/git/trees");
    const treePaths = new Map<string, any>(treeCall.body.tree.map((e: any) => [e.path, e]));
    assert.equal(treePaths.get("root.nix")?.content, "{ root = false; }\n");
    assert.equal(treePaths.get("subpkg/a.nix")?.content, "{ a = 2; }\n");
    assert.equal(treePaths.get("added.nix")?.content, "{ added = 1; }\n");
    assert.equal(treePaths.get("ignored.txt")?.sha, null, "deleted file must be committed with sha: null");

    // (f) Guard-out blocked proposal is refused (`acted: false`)
    ghLogin = "genie-bot";
    ghRepoPermissions = { push: false, maintain: false, admin: false };
    const blockedControl = await runBroker(nBlock.base);
    assert.equal(blockedControl.acted, false);
    assert.match(blockedControl.reason, /^guard-out: leak/);
  } finally {
    daemon.kill();
    nPass.close();
    nBlock.close();
    ghServer.close();
    rmSync(rootTmp, { recursive: true, force: true });
  }
});

// Typed gist operations use the same broker, with an inbound screen for fetched data.
import * as brokerModule from "../src/broker/index.ts";
import { errors as schemaErrors, forModel, fromModel, load as loadSchema } from "../src/tier1/schema.ts";
const readGist = (content = "untrusted text") => ({
  untrusted: true as const, id: "abc123", url: "https://gist.github.com/account/abc123",
  description: "review", owner: "account", revision: "a".repeat(40), files: { "note.md": content },
});

test("gist operations: kinds have independent strict arguments and public survives model conversion", async () => {
  const schema = loadSchema("proposal");
  for (const p of [
    { kind: "gist_read", id: "abc123" },
    { kind: "gist_update", id: "https://gist.github.com/account/abc123", files: { "note.md": "replacement" } },
    { kind: "gist_comment", id: "abc123", body: "review" },
  ]) assert.deepEqual(schemaErrors(schema, p), [], JSON.stringify(p));
  for (const p of [
    { kind: "gist_read", id: "abc123", public: true },
    { kind: "gist_read", id: "abc123", files: { a: "b" } },
    { kind: "gist_update", id: "abc123", files: {} },
    { kind: "gist_comment", id: "abc123", body: "" },
    { kind: "gist_comment", id: "abc123", body: "review", repo: "a/b" },
    { kind: "pr", repo: "a/b", branch: "fix", files: { a: "b" }, title: "t", body: "", public: true },
  ]) assert.notDeepEqual(schemaErrors(schema, p), [], JSON.stringify(p));
  assert.deepEqual(forModel(schema).properties.public.enum, ["yes", "no"]);
  for (const [model, expected] of [["yes", true], ["no", false]] as const) {
    const p = fromModel(schema, { ...JSON.parse(gist()), public: model });
    const recording = recordingAct();
    assert.equal((await broker("thread", JSON.stringify(p), { tokenFile: tokenFile("credential"), guard: { enable: false }, act: recording.act })).acted, true);
    assert.equal(recording.calls[0].p.public, expected);
  }
});

test("gist operations: target IDs normalize without fetching caller URLs or revisions", () => {
  for (const raw of ["abc123", "ABC123", "https://gist.github.com/abc123", "https://gist.github.com/account/abc123?file=a#note"]) {
    assert.equal(brokerModule.normalizeGistId(raw), "abc123");
  }
  for (const raw of ["", "not-hex", "https://evil.example/abc123", "http://gist.github.com/abc123", "https://user@gist.github.com/abc123", "https://gist.github.com/account/abc123/deadbeef", "https://gist.githubusercontent.com/account/abc123/raw/note", "https://gist.github.com/account/../abc123", "https://gist.github.com/account/abc123/../def456", "https://gist.github.com/account/%61bc123", " abc123"]) {
    assert.throws(() => brokerModule.normalizeGistId(raw), undefined, raw);
  }
});

test("gist operations: anonymous read skips guard-out but requires an inbound processor", async () => {
  const n = await ninfer(verdict("block", "not a publication"));
  let calls = 0;
  try {
    const config = { tokenFile: null, guard: { base: n.base, model: "m", system: "guard-out" }, act: async (p: Proposal, token: string) => {
      calls++; assert.equal(token, ""); assert.equal(p.id, "abc123"); return { url: readGist().url, gist: readGist() };
    }, readScreen: async (text: string) => text };
    const action = await broker("thread", JSON.stringify({ kind: "gist_read", id: "https://gist.github.com/account/abc123" }), config);
    assert.equal(action.acted, true, action.reason);
    assert.equal(action.gist?.untrusted, true);
    assert.equal(calls, 1); assert.equal(n.requests.length, 0);
    const missingScreen = await broker("thread", JSON.stringify({ kind: "gist_read", id: "abc123" }), { ...config, readScreen: undefined });
    assert.equal(missingScreen.acted, false); assert.equal(calls, 1);
    const missingToken = await broker("thread", JSON.stringify({ kind: "gist_comment", id: "abc123", body: "review" }), { ...config, guard: { enable: false } });
    assert.equal(missingToken.acted, false); assert.equal(calls, 1);
  } finally { n.close(); }
});

test("gist operations: read scrubs before and after screening, bounds output and withholds errors", async () => {
  const token = randomUUID();
  const shaped = credential();
  const raw = JSON.stringify({ kind: "gist_read", id: "abc123" });
  const act = async () => ({ url: readGist().url, gist: readGist(`${token} ${shaped}`) });
  const c = { tokenFile: tokenFile(token), guard: { enable: false as const }, act };
  let screened = "";
  const action = await broker("thread", raw, { ...c, readScreen: async (text) => {
    screened = text; const p = JSON.parse(text); p.files["note.md"] = `rewritten ${token} ${shaped}`; p.untrusted = false; return JSON.stringify(p);
  } });
  assert.equal(action.acted, true, action.reason);
  assert.equal(action.gist?.untrusted, true);
  assert.ok(!screened.includes(token) && !screened.includes(shaped));
  assert.ok(!JSON.stringify(action).includes(token) && !JSON.stringify(action).includes(shaped));
  for (const readScreen of [
    async () => { throw new Error(`reflected ${token} ${shaped}`); },
    async () => "not json",
    async () => JSON.stringify(readGist("x".repeat(65_536))),
    async () => JSON.stringify({ ...readGist(), id: "def456" }),
  ]) {
    const failed = await broker("thread", raw, { ...c, readScreen });
    assert.equal(failed.acted, false);
    assert.equal(failed.gist, undefined);
    assert.ok(!JSON.stringify(failed).includes(token) && !JSON.stringify(failed).includes(shaped));
  }
  let called = false;
  const oversized = await broker("thread", raw, { ...c, act: async () => ({ url: readGist().url, gist: readGist("x".repeat(65_536)) }), readScreen: async (s) => { called = true; return s; } });
  assert.equal(oversized.acted, false); assert.equal(called, false);
  const unreadable = await broker("thread", raw, { ...c, tokenFile: "/missing/gist-token", readScreen: async (s) => s });
  assert.equal(unreadable.acted, false);
});

test("gist operations: update and comment preserve write guard-out and partial action maps refuse", async () => {
  for (const p of [{ kind: "gist_update", id: "abc123", files: { "note.md": "replacement" } }, { kind: "gist_comment", id: "abc123", body: "review" }]) {
    const blocked = await run(verdict("block", "leak"), JSON.stringify(p));
    assert.equal(blocked.calls.length, 0); assert.match(blocked.action.reason, /^guard-out:/);
  }
  const act = byKind({ gist: recordingAct().act, pr: recordingAct().act });
  await assert.rejects(() => act({ kind: "gist_read", id: "abc123" }, "", "thread"), /no action/);
});

test("gist operations: anonymous screen failures stay readable and configured identity failures never fall back", async () => {
  let acts = 0;
  let screens = 0;
  const c = { tokenFile: null, guard: { enable: false as const }, act: async () => { acts++; return { url: readGist().url, gist: readGist() }; }, readScreen: async () => { screens++; throw new Error("inbound screen unavailable"); } };
  const raw = JSON.stringify({ kind: "gist_read", id: "abc123" });
  const refused = await broker("thread", raw, c);
  assert.equal(refused.acted, false);
  assert.match(refused.reason, /inbound screen unavailable/);
  assert.equal(acts, 1); assert.equal(screens, 1, "disabled outbound guard must not bypass inbound screening");
  const requests: string[] = [];
  const api = createServer((req, res) => { requests.push(req.url!); res.writeHead(401); res.end('{}'); });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  try {
    const port = (api.address() as { port: number }).port;
    const configured = await broker("thread", raw, { ...c, tokenFile: tokenFile("configured-invalid-token"), botLogin: "machine-account", githubApi: `http://127.0.0.1:${port}` });
    assert.equal(configured.acted, false);
    assert.equal(acts, 1, "invalid configured token fell back to anonymous Act");
    assert.deepEqual(requests, ["/user"]);
    assert.equal(screens, 1);
  } finally { api.close(); }
});

test("gist operations: redacted target metadata refuses without throwing or invoking an Act", async () => {
  const id = "abcdef1234567890";
  const hash = (await import("../src/redactor/index.ts")).secretLineHashes(id);
  let calls = 0;
  const result = await broker("thread", JSON.stringify({ kind: "gist_read", id }), {
    tokenFile: null, guard: { enable: false }, secretFileHashes: hash,
    readScreen: async (s) => s,
    act: async () => { calls++; return { url: readGist().url, gist: readGist() }; },
  });
  assert.equal(result.acted, false);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(result).includes(id));
});
