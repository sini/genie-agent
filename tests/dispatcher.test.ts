// The dispatcher core's gating oracle (design oracle 24): a second escalation of a parked thread
// launches with --resume and its first launch's uuid, under the same token's config directory,
// including across a dispatcher kill and a restart from the journal. Run with
// `node --test tests/dispatcher.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Dispatcher, type Options } from "../src/dispatcher/index.ts";
import { CliHerdr, type Herdr, type HerdrAgent, type StartSpec } from "../src/dispatcher/herdr.ts";

// A herdr server that outlives the dispatcher, recording every call.
class FakeHerdr implements Herdr {
  starts: StartSpec[] = [];
  closes: string[] = [];
  panes = new Map<string, string>(); // pane → session uuid
  private next = 2;

  async start(spec: StartSpec): Promise<string> {
    this.starts.push(spec);
    const pane = `w1:p${this.next++}`;
    const at = spec.args.findIndex((a) => a === "--session-id" || a === "--resume");
    this.panes.set(pane, spec.args[at + 1]);
    return pane;
  }
  async close(pane: string): Promise<void> {
    this.closes.push(pane);
    this.panes.delete(pane);
  }
  async list(): Promise<HerdrAgent[]> {
    return [...this.panes.keys()].map((pane) => ({ pane }));
  }
}

const setup = () => {
  const herdr = new FakeHerdr();
  // xmsg lists exactly the sessions whose panes are alive, unless a test says otherwise.
  const xmsg = { gone: new Set<string>(), list: async () => [...herdr.panes.values()].filter((s) => !xmsg.gone.has(s)) };
  const o: Options = {
    stateDir: `${mkdtempSync(`${tmpdir()}/d1a-`)}/state`,
    herdr,
    xmsg,
    pickToken: () => ({ id: "tok-a", configDir: "/home/genie-public/tokens/tok-a" }),
    cwd: "/var/lib/genie-public/cwd",
    model: "opus",
  };
  return { herdr, xmsg, o };
};

test("a first escalation launches a minted uuid under its token's config directory", async () => {
  const { herdr, o } = setup();
  const d = await Dispatcher.open(o);
  const t = await d.escalate("!room:thread-1");
  assert.match(t.session, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(herdr.starts.length, 1);
  assert.deepEqual(herdr.starts[0].args, ["-n", t.name, "--session-id", t.session, "--model", "opus"]);
  assert.equal(herdr.starts[0].configDir, "/home/genie-public/tokens/tok-a");
  assert.deepEqual(d.journal.tokens, { "tok-a": { state: "available" } });
  assert.notEqual((await Dispatcher.open(o)).journal.threads["!room:thread-1"], undefined);
});

test("a live thread is not launched again", async () => {
  const { herdr, o } = setup();
  const d = await Dispatcher.open(o);
  await d.escalate("t");
  await d.escalate("t");
  assert.equal(herdr.starts.length, 1);
});

test("a parked thread resumes with its first launch's uuid", async () => {
  const { herdr, o } = setup();
  const d = await Dispatcher.open(o);
  const first = (await d.escalate("t")).session;
  await d.park("t");
  await d.escalate("t");
  assert.equal(herdr.starts.length, 2);
  assert.deepEqual(herdr.starts[1].args, ["--resume", first, "--model", "opus"]);
  assert.equal(herdr.starts[1].configDir, herdr.starts[0].configDir);
});

test("oracle 24: a parked thread resumes with its first launch's uuid across a kill and restart", async () => {
  const { herdr, o } = setup();
  let d: Dispatcher | undefined = await Dispatcher.open(o);
  const first = (await d.escalate("t")).session;
  await d.park("t");
  d = undefined; // the kill: nothing survives but the journal and the herdr server
  const restarted = await Dispatcher.open(o);
  await restarted.escalate("t");
  assert.equal(herdr.starts.length, 2);
  assert.deepEqual(herdr.starts[1].args, ["--resume", first, "--model", "opus"]);
  assert.equal(herdr.starts[1].configDir, "/home/genie-public/tokens/tok-a");
});

test("a pane that survives the kill stays live and is not launched again", async () => {
  const { herdr, o } = setup();
  await (await Dispatcher.open(o)).escalate("t");
  const restarted = await Dispatcher.open(o);
  assert.equal(restarted.journal.threads.t.state, "live");
  await restarted.escalate("t");
  assert.equal(herdr.starts.length, 1);
  assert.deepEqual(herdr.closes, []);
});

test("a pane gone while the dispatcher was down is parked on restart, then resumed", async () => {
  const { herdr, o } = setup();
  const t = await (await Dispatcher.open(o)).escalate("t");
  herdr.panes.delete(t.pane!);
  const restarted = await Dispatcher.open(o);
  assert.equal(restarted.journal.threads.t.state, "parked");
  await restarted.escalate("t");
  assert.deepEqual(herdr.starts[1].args, ["--resume", t.session, "--model", "opus"]);
});

test("a pane whose session xmsg no longer lists is closed and parked on restart", async () => {
  const { herdr, xmsg, o } = setup();
  const t = await (await Dispatcher.open(o)).escalate("t");
  xmsg.gone.add(t.session);
  const restarted = await Dispatcher.open(o);
  assert.deepEqual(herdr.closes, [t.pane]);
  assert.equal(restarted.journal.threads.t.state, "parked");
});

test("the journal is replaced whole, at 0600, with no temporary left", async () => {
  const { o } = setup();
  await (await Dispatcher.open(o)).escalate("t");
  assert.deepEqual(readdirSync(o.stateDir).sort(), ["journal.json", "worktrees"]);
  assert.equal(statSync(`${o.stateDir}/journal.json`).mode & 0o777, 0o600);
});

test("an unreadable journal refuses to start rather than forgetting every thread", async () => {
  const { o } = setup();
  await (await Dispatcher.open(o)).escalate("t");
  writeFileSync(`${o.stateDir}/journal.json`, "{");
  await assert.rejects(Dispatcher.open(o));
  assert.ok(existsSync(`${o.stateDir}/journal.json`));
});

// The real adapter, by its command lines.
const cli = (replies: Record<string, string>, claude?: string) => {
  const calls: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  const herdr = new CliHerdr({
    session: "public",
    claude,
    run: async (argv, env) => {
      calls.push({ argv, env });
      const key = argv.slice(3, 5).join(" ");
      if (replies[key] === undefined) throw new Error(`${argv.join(" ")}: ${replies[`${key} error`]}`);
      return replies[key];
    },
  });
  return { herdr, calls };
};
const ok = (result: object) => JSON.stringify({ id: "cli", result });

test("the cli adapter splits a pane under the config directory and starts claude in it", async () => {
  process.env.HERDR_SOCKET_PATH = "/elsewhere/herdr.sock";
  const { herdr, calls } = cli({
    "pane list": ok({ panes: [{ pane_id: "w1:p1" }] }),
    "pane split": ok({ pane: { pane_id: "w1:p7" } }),
    "agent start": ok({ type: "agent_started" }),
  });
  const pane = await herdr.start({ name: "genie-1", configDir: "/cfg/a", cwd: "/cwd", args: ["--resume", "u-1"] });
  assert.equal(pane, "w1:p7");
  assert.deepEqual(
    calls.map((c) => c.argv),
    [
      ["herdr", "--session", "public", "pane", "list"],
      ["herdr", "--session", "public", "pane", "split", "w1:p1", "--direction", "right", "--cwd", "/cwd",
        "--env", "CLAUDE_CONFIG_DIR=/cfg/a", "--no-focus"],
      ["herdr", "--session", "public", "agent", "start", "genie-1", "--kind", "claude", "--pane", "w1:p7",
        "--timeout", "60000", "--", "--resume", "u-1"],
    ],
  );
  assert.equal(calls[0].env.HERDR_SOCKET_PATH, undefined);
});

test("the cli adapter creates a workspace when herdr has no panes yet and caches the root pane", async () => {
  const { herdr, calls } = cli({
    "pane list": ok({ panes: [] }),
    "workspace create": ok({ root_pane: { pane_id: "w1:p1" } }),
    "pane split": ok({ pane: { pane_id: "w1:p2" } }),
    "agent start": ok({ type: "agent_started" }),
  });
  const pane1 = await herdr.start({ name: "genie-1", configDir: "/cfg/a", cwd: "/cwd", args: ["--resume", "u-1"] });
  const pane2 = await herdr.start({ name: "genie-2", configDir: "/cfg/b", cwd: "/cwd", args: ["--resume", "u-2"] });
  assert.equal(pane1, "w1:p2");
  assert.equal(pane2, "w1:p2");
  assert.deepEqual(
    calls.map((c) => c.argv),
    [
      ["herdr", "--session", "public", "pane", "list"],
      ["herdr", "--session", "public", "workspace", "create", "--cwd", "/cwd", "--no-focus"],
      ["herdr", "--session", "public", "pane", "split", "w1:p1", "--direction", "right", "--cwd", "/cwd",
        "--env", "CLAUDE_CONFIG_DIR=/cfg/a", "--no-focus"],
      ["herdr", "--session", "public", "agent", "start", "genie-1", "--kind", "claude", "--pane", "w1:p2",
        "--timeout", "60000", "--", "--resume", "u-1"],
      ["herdr", "--session", "public", "pane", "split", "w1:p1", "--direction", "right", "--cwd", "/cwd",
        "--env", "CLAUDE_CONFIG_DIR=/cfg/b", "--no-focus"],
      ["herdr", "--session", "public", "agent", "start", "genie-2", "--kind", "claude", "--pane", "w1:p2",
        "--timeout", "60000", "--", "--resume", "u-2"],
    ],
  );
});

test("the cli adapter passes --command to herdr agent start when claude path is configured", async () => {
  const { herdr, calls } = cli({
    "pane list": ok({ panes: [{ pane_id: "w1:p1" }] }),
    "pane split": ok({ pane: { pane_id: "w1:p7" } }),
    "agent start": ok({ type: "agent_started" }),
  }, "/nix/store/claude/bin/claude");
  await herdr.start({ name: "genie-1", configDir: "/cfg/a", cwd: "/cwd", args: ["--resume", "u-1"] });
  assert.deepEqual(
    calls[2].argv,
    ["herdr", "--session", "public", "agent", "start", "genie-1", "--kind", "claude", "--pane", "w1:p7",
      "--command", "/nix/store/claude/bin/claude", "--timeout", "60000", "--", "--resume", "u-1"],
  );
});

test("the cli adapter closes the pane when claude does not start", async () => {
  const { herdr, calls } = cli({
    "pane list": ok({ panes: [{ pane_id: "w1:p1" }] }),
    "pane split": ok({ pane: { pane_id: "w1:p7" } }),
    "agent start error": '{"error":{"code":"agent_not_ready"}}',
    "pane close": ok({ type: "ok" }),
  });
  await assert.rejects(herdr.start({ name: "n", configDir: "/c", cwd: "/w", args: [] }), /agent_not_ready/);
  assert.deepEqual(calls[3].argv, ["herdr", "--session", "public", "pane", "close", "w1:p7"]);
});

test("the cli adapter treats an absent pane as closed and throws any other refusal", async () => {
  await cli({ "pane close error": '{"error":{"code":"pane_not_found"}}' }).herdr.close("w1:p9");
  await assert.rejects(cli({ "pane close error": '{"error":{"code":"internal"}}' }).herdr.close("w1:p9"));
});

test("the cli adapter lists agents by pane", async () => {
  const { herdr, calls } = cli({ "agent list": ok({ agents: [{ pane_id: "w1:p2", name: "genie-1" }] }) });
  assert.deepEqual(await herdr.list(), [{ pane: "w1:p2", name: "genie-1" }]);
  assert.deepEqual(calls[0].argv, ["herdr", "--session", "public", "agent", "list"]);
});

test(
  "oracle GI-14: first escalation against a real herdr server lazily creates the base pane and starts claude",
  { timeout: 30_000 },
  async () => {
    const dir = mkdtempSync(`${tmpdir()}/gi14-`);
    const session = `gi14-${process.pid}-${Date.now()}`;
    const claudeBin = `${dir}/claude`;
    const claudeLog = `${dir}/claude.log`;
    writeFileSync(
      claudeBin,
      `#!/bin/sh\nprintf 'args=%s\\ncfg=%s\\n' "$*" "$CLAUDE_CONFIG_DIR" >> "${claudeLog}"\nwhile IFS= read -r _; do :; done\n`,
      { mode: 0o755 },
    );
    chmodSync(claudeBin, 0o755);
    mkdirSync(`${dir}/state`, { recursive: true });
    mkdirSync(`${dir}/cwd`, { recursive: true });
    mkdirSync(`${dir}/cfg-a`, { recursive: true });

    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_RUNTIME_DIR;
    const prevShell = process.env.SHELL;
    process.env.HOME = dir;
    process.env.XDG_RUNTIME_DIR = dir;
    process.env.SHELL = process.env.SHELL || "/bin/sh";
    const mkHerdr = () =>
      new CliHerdr({
        session,
        claude: claudeBin,
        cwdDir: `${dir}/cwd`,
        readyTimeoutMs: 15_000,
      });
    const herdr1 = mkHerdr();
    const herdr2 = mkHerdr();
    const srv = spawn("herdr", ["--session", session, "server"], {
      env: { ...process.env },
      stdio: "ignore",
    });
    process.env.HOME = prevHome;
    process.env.XDG_RUNTIME_DIR = prevXdg;
    if (prevShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = prevShell;

    try {
      for (let i = 0; i < 100; i++) {
        try {
          await herdr1.list();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      const d1 = await Dispatcher.open({
        stateDir: `${dir}/state`,
        herdr: herdr1,
        xmsg: { list: async () => [] },
        pickToken: () => ({ id: "tok-a", configDir: `${dir}/cfg-a` }),
        cwd: `${dir}/cwd`,
      });
      const t1 = await d1.escalate("t1");
      assert.equal(t1.state, "live");
      assert.equal(t1.pane, "w1:p2");
      assert.deepEqual(await herdr1.list(), [{ pane: "w1:p2", name: t1.name }]);

      // A second CliHerdr against the same server finds w1:p1 via `pane list` instead of creating w2.
      const d2 = await Dispatcher.open({
        stateDir: `${dir}/state`,
        herdr: herdr2,
        xmsg: { list: async () => [t1.session] },
        pickToken: () => ({ id: "tok-a", configDir: `${dir}/cfg-a` }),
        cwd: `${dir}/cwd`,
      });
      const t2 = await d2.escalate("t2");
      assert.equal(t2.state, "live");
      assert.equal(t2.pane, "w1:p3");

      const logText = readFileSync(claudeLog, "utf8");
      assert.match(logText, new RegExp(`--session-id ${t1.session}`));
      assert.match(logText, new RegExp(`--session-id ${t2.session}`));
      assert.match(logText, new RegExp(`cfg=${dir}/cfg-a`));
    } finally {
      srv.kill("SIGTERM");
      await new Promise<void>((resolve) => srv.once("exit", () => resolve()));
    }
  },
);

test(
  "oracle GI-15 (K7 + SO_PEERPIDFD socketpair): CliHerdr splits panes in cwdDir and hands off token over SCM_RIGHTS socketpair",
  { timeout: 30_000 },
  async () => {
    const dir = mkdtempSync(`${tmpdir()}/gi15-unit-`);
    const stateDir = `${dir}/dispatcher-public`;
    const cwdDir = `${dir}/cwd-public`;
    const cfgDir = `${dir}/claude-public`;
    const credFile = `${dir}/tier-token`;
    const shimBin = `${dir}/genie-claude-shim`;
    const handoffOut = `${dir}/handoff.json`;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(cwdDir, { recursive: true, mode: 0o700 });
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    writeFileSync(credFile, "CLAUDE_CODE_OAUTH_TOKEN=canary-unit-token-0000\n", { mode: 0o600 });
    writeFileSync(
      shimBin,
      [
        "import json, os, socket, stat, sys",
        "sep = sys.argv.index('--')",
        "head = sys.argv[1:sep]",
        "tail = sys.argv[sep+1:]",
        "sock_path = head[1]",
        "thread_id = head[3]",
        "pane_cwd = head[5]",
        "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
        "s.connect(sock_path)",
        "msg, fds, _, _ = socket.recv_fds(s, 16, 1)",
        "s.close()",
        "fd = fds[0]",
        "is_sock = stat.S_ISSOCK(os.fstat(fd).st_mode)",
        "with os.fdopen(fd, 'rb', closefd=True) as f:",
        "    tok = f.read().decode('utf-8').strip()",
        `with open(${JSON.stringify(handoffOut)}, 'w', encoding='utf-8') as out:`,
        "    json.dump({'thread_id': thread_id, 'pane_cwd': pane_cwd, 'is_sock': is_sock, 'tok': tok, 'tail': tail, 'shell_cwd': os.getcwd()}, out)",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const selfNspids = readFileSync("/proc/self/status", "utf8")
      .split("\n")
      .find((l) => l.startsWith("NSpid:"))!
      .trim()
      .split(/\s+/)
      .slice(1);
    const calls: string[][] = [];
    const herdr = new CliHerdr({
      session: "genie-public",
      claude: shimBin,
      cwdDir,
      stateDir,
      tokenCredentialFile: credFile,
      expectedNspidDepth: selfNspids.length,
      run: async (argv) => {
        calls.push(argv);
        const key = argv.slice(3, 5).join(" ");
        if (key === "pane list") return ok({ panes: [] });
        if (key === "workspace create") return ok({ root_pane: { pane_id: "w1:p1" } });
        if (key === "pane split") return ok({ pane: { pane_id: "w1:p2" } });
        if (key === "agent start") {
          const sep = argv.indexOf("--");
          const cmd = argv[argv.indexOf("--command") + 1];
          const shimArgs = argv.slice(sep + 1);
          await new Promise<void>((resolve, reject) => {
            const p = spawn("python3", ["-I", cmd, ...shimArgs], { cwd: cwdDir, stdio: "ignore" });
            p.once("error", reject);
            p.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`shim exited ${code}`))));
          });
          return ok({ type: "agent_started" });
        }
        throw new Error(`unexpected herdr command: ${argv.join(" ")}`);
      },
    });

    const wtCwd = `${stateDir}/worktrees/thread-A`;
    const pane = await herdr.start({
      name: "genie-12345678",
      threadId: "thread-A",
      configDir: cfgDir,
      cwd: wtCwd,
      paneCwd: cwdDir,
      args: ["-n", "genie-12345678", "--session-id", "12345678-0000-4000-8000-000000000000"],
    });
    assert.equal(pane, "w1:p2");
    // K7: workspace create and pane split use cwdDir, never wtCwd
    assert.deepEqual(calls[1], [
      "herdr",
      "--session",
      "genie-public",
      "workspace",
      "create",
      "--cwd",
      cwdDir,
      "--no-focus",
    ]);
    assert.deepEqual(calls[2], [
      "herdr",
      "--session",
      "genie-public",
      "pane",
      "split",
      "w1:p1",
      "--direction",
      "right",
      "--cwd",
      cwdDir,
      "--env",
      `CLAUDE_CONFIG_DIR=${cfgDir}`,
      "--no-focus",
    ]);
    const recorded = JSON.parse(readFileSync(handoffOut, "utf8"));
    assert.equal(recorded.thread_id, "thread-A");
    assert.equal(recorded.pane_cwd, wtCwd);
    assert.equal(recorded.shell_cwd, cwdDir);
    assert.equal(recorded.is_sock, true);
    assert.equal(recorded.tok, "canary-unit-token-0000");
    assert.deepEqual(readdirSync(`${stateDir}/launch`), []);
  },
);
