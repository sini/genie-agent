// The dispatcher core's gating oracle (design oracle 24): a second escalation of a parked thread
// launches with --resume and its first launch's uuid, under the same token's config directory,
// including across a dispatcher kill and a restart from the journal. Run with
// `node --test tests/dispatcher.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
        if (key === "pane close") return ok({ type: "ok" });
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

function countSplitNeedle(buf: Buffer, head: Buffer, tail: Buffer, minIdx = 0): number {
  let hits = 0;
  let idx = Math.max(0, minIdx);
  const totalLen = head.length + tail.length;
  const limit = buf.length - totalLen;
  while (idx <= limit && (idx = buf.indexOf(head, idx)) !== -1) {
    if (idx <= limit && buf.subarray(idx + head.length, idx + totalLen).equals(tail)) {
      hits++;
      idx += totalLen;
    } else {
      idx += 1;
    }
  }
  return hits;
}

function scanPidMem(
  pid: number,
  runtimeNeedles?: { sockHead: Buffer; sockTail: Buffer; tidHead: Buffer; tidTail: Buffer },
): {
  tokHits: number;
  ctrlHits: number;
  sockHits: number;
  tidHits: number;
  regions: number;
  readErrors: number;
  emptyReads: number;
} {
  // Keep head and tail in separate Buffers so the scanner itself never forms a contiguous copy of the canary token.
  const tokHead = Buffer.from("canary-gt3-", "utf8");
  const tokTail = Buffer.from("unit-token-0000", "utf8");
  const ctrlHead = Buffer.from("GENIE_DISP_", "utf8");
  const ctrlTail = Buffer.from("MEM_CONTROL_0000", "utf8");

  const maps = readFileSync(`/proc/${pid}/maps`, "utf8").split("\n");
  const memFd = openSync(`/proc/${pid}/mem`, "r");
  const chunkSize = 4 * 1024 * 1024;
  const chunk = Buffer.alloc(chunkSize);
  const tokOverlap = tokHead.length + tokTail.length - 1;
  const ctrlOverlap = ctrlHead.length + ctrlTail.length - 1;
  const sockOverlap = runtimeNeedles ? runtimeNeedles.sockHead.length + runtimeNeedles.sockTail.length - 1 : 0;
  const tidOverlap = runtimeNeedles ? runtimeNeedles.tidHead.length + runtimeNeedles.tidTail.length - 1 : 0;
  const maxOverlap = Math.max(tokOverlap, ctrlOverlap, sockOverlap, tidOverlap);
  const step = chunkSize - maxOverlap;

  let tokHits = 0;
  let ctrlHits = 0;
  let sockHits = 0;
  let tidHits = 0;
  let regions = 0;
  let readErrors = 0;
  let emptyReads = 0;
  try {
    for (const line of maps) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2 || !parts[1].includes("r")) continue;
      const pathname = parts.length >= 6 ? parts.slice(5).join(" ") : "";
      if (pathname === "[vvar]" || pathname === "[vvar_vclock]" || pathname === "[vdso]" || pathname === "[vsyscall]")
        continue;
      if (pathname.startsWith("/nix/store/") && !parts[1].includes("w")) continue;
      const [startHex, endHex] = parts[0].split("-");
      const start = Number.parseInt(startHex, 16);
      const end = Number.parseInt(endHex, 16);
      if (end <= start) continue;
      for (let pos = start; pos < end; pos += step) {
        const toRead = Math.min(chunkSize, end - pos);
        let n = 0;
        try {
          n = readSync(memFd, chunk, 0, toRead, pos);
        } catch {
          readErrors++;
          break;
        }
        if (n <= 0) {
          emptyReads++;
          break;
        }
        regions++;
        const isFirstChunk = pos === start;
        const view = chunk.subarray(0, n);
        tokHits += countSplitNeedle(view, tokHead, tokTail, isFirstChunk ? 0 : maxOverlap - tokOverlap);
        ctrlHits += countSplitNeedle(view, ctrlHead, ctrlTail, isFirstChunk ? 0 : maxOverlap - ctrlOverlap);
        if (runtimeNeedles) {
          sockHits += countSplitNeedle(
            view,
            runtimeNeedles.sockHead,
            runtimeNeedles.sockTail,
            isFirstChunk ? 0 : maxOverlap - sockOverlap,
          );
          tidHits += countSplitNeedle(
            view,
            runtimeNeedles.tidHead,
            runtimeNeedles.tidTail,
            isFirstChunk ? 0 : maxOverlap - tidOverlap,
          );
        }
        view.fill(0);
        if (pos + toRead >= end) break;
      }
    }
  } finally {
    closeSync(memFd);
  }
  return { tokHits, ctrlHits, sockHits, tidHits, regions, readErrors, emptyReads };
}

function findHandoffPidBySock(sockPath: string): number {
  const needle = Buffer.from(sockPath, "utf8");
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`);
      if (cmdline.includes(needle)) return pid;
    } catch {}
  }
  throw new Error(`could not find HANDOFF_SERVER_PY process for ${sockPath}`);
}

test(
  "oracle GT3 (Arm A1): zero V8 and Python accept-window token residency across credential formats, D4b validated token id under CREDENTIALS_DIRECTORY, and pre-split refusal on invalid credentials",
  { timeout: 30_000 },
  async () => {
    const dir = mkdtempSync(`${tmpdir()}/gt3-unit-`);
    const credDir = `${dir}/creds`;
    const outsideDir = `${dir}/outside`;
    const stateDir = `${dir}/dispatcher-public`;
    const cwdDir = `${dir}/cwd-public`;
    const cfgDir = `${dir}/claude-public`;
    const shimBin = `${dir}/genie-claude-shim`;
    const handoffOut = `${dir}/handoff.json`;
    mkdirSync(credDir, { recursive: true, mode: 0o700 });
    mkdirSync(outsideDir, { recursive: true, mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(cwdDir, { recursive: true, mode: 0o700 });
    mkdirSync(cfgDir, { recursive: true, mode: 0o700 });

    // C7 unit check: verify overlapped chunk scanning detects a token straddling a 4 MiB chunk boundary.
    {
      const chunkSize = 4 * 1024 * 1024;
      const head = Buffer.from("canary-gt3-", "utf8");
      const tail = Buffer.from("unit-token-0000", "utf8");
      const overlap = head.length + tail.length - 1;
      const step = chunkSize - overlap;
      const twoChunks = Buffer.alloc(chunkSize + 4096);
      const straddleOffset = chunkSize - 7; // 7 bytes in chunk 0, 19 bytes in chunk 1
      head.copy(twoChunks, straddleOffset);
      tail.copy(twoChunks, straddleOffset + head.length);
      const c0 = twoChunks.subarray(0, chunkSize);
      const c1 = twoChunks.subarray(step, step + 4096 + overlap);
      const hitsNoOverlap =
        countSplitNeedle(c0, head, tail, 0) + countSplitNeedle(twoChunks.subarray(chunkSize), head, tail, 0);
      const hitsWithOverlap = countSplitNeedle(c0, head, tail, 0) + countSplitNeedle(c1, head, tail, 0);
      twoChunks.fill(0);
      assert.equal(hitsNoOverlap, 0, "unoverlapped 4 MiB boundary split must miss straddling needle");
      assert.equal(hitsWithOverlap, 1, "overlapped 4 MiB boundary scan must detect straddling needle exactly once");
    }

    // Generate the 5 credential files under credDir (`tier-token-<k>`) in a short-lived python3 child
    // so the test runner's V8 heap never allocates a JS string literal for the canary token.
    const pyGen = [
      "import hashlib, json, os, sys",
      "d = sys.argv[1]",
      "tok = 'canary-gt3-' + 'unit-token-' + '0000'",
      "variants = {",
      "  'kv': f'CLAUDE_CODE_OAUTH_TOKEN={tok}\\n',",
      "  'export_dquote': f'export CLAUDE_CODE_OAUTH_TOKEN=\"{tok}\"\\n',",
      "  'comment_squote': f'# leading comment\\n  CLAUDE_CODE_OAUTH_TOKEN=\\'{tok}\\'  \\n',",
      "  'raw': f'  {tok}  \\n',",
      "  'crlf': f'# crlf comment\\r\\nexport CLAUDE_CODE_OAUTH_TOKEN={tok}\\r\\n',",
      "}",
      "ids = []",
      "for k, content in variants.items():",
      "    p = os.path.join(d, f'tier-token-{k}')",
      "    with open(p, 'wb') as f:",
      "        f.write(content.encode('utf-8'))",
      "    os.chmod(p, 0o600)",
      "    ids.append(k)",
      "print(json.dumps({'sha256': hashlib.sha256(tok.encode('utf-8')).hexdigest(), 'len': len(tok), 'ids': ids}))",
    ].join("\n");
    const genRes = spawnSync("python3", ["-I", "-c", pyGen, credDir], { encoding: "utf8" });
    assert.equal(genRes.status, 0, genRes.stderr);
    const { sha256: expectedSha256, len: expectedLen, ids: variantIds } = JSON.parse(genRes.stdout.trim()) as {
      sha256: string;
      len: number;
      ids: string[];
    };

    // Plant positive control string in Node's V8 heap.
    (globalThis as Record<string, unknown>).__GT3_MEM_CONTROL = ["GENIE_DISP", "MEM_CONTROL", "0000"]
      .join("_")
      .repeat(4);

    // Shim records only sha256 and length of the received token, never writing the plaintext token to disk.
    writeFileSync(
      shimBin,
      [
        "import hashlib, json, os, socket, stat, sys",
        "sep = sys.argv.index('--')",
        "head = sys.argv[1:sep]",
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
        "    raw = bytearray(f.read())",
        "while raw and raw[-1] in (10, 13):",
        "    raw.pop()",
        "digest = hashlib.sha256(raw).hexdigest()",
        "tok_len = len(raw)",
        "for i in range(len(raw)):",
        "    raw[i] = 0",
        `with open(${JSON.stringify(handoffOut)}, 'w', encoding='utf-8') as out:`,
        "    json.dump({'thread_id': thread_id, 'pane_cwd': pane_cwd, 'is_sock': is_sock, 'tok_sha256': digest, 'tok_len': tok_len}, out)",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );

    const selfNspids = readFileSync("/proc/self/status", "utf8")
      .split("\n")
      .find((l) => l.startsWith("NSpid:"))!
      .trim()
      .split(/\s+/)
      .slice(1);

    let activeTokenId = variantIds[0];
    let duringAcceptChecked = 0;
    const calls: string[][] = [];

    const herdr = new CliHerdr({
      session: "genie-public",
      claude: shimBin,
      cwdDir,
      stateDir,
      credentialsDir: credDir,
      resolveTokenId: () => activeTokenId,
      expectedNspidDepth: selfNspids.length,
      run: async (argv) => {
        calls.push(argv);
        const key = argv.slice(3, 5).join(" ");
        if (key === "pane list") return ok({ panes: [] });
        if (key === "workspace create") return ok({ root_pane: { pane_id: "w1:p1" } });
        if (key === "pane split") return ok({ pane: { pane_id: "w1:p2" } });
        if (key === "pane close") return ok({ type: "ok" });
        if (key === "agent start") {
          const sep = argv.indexOf("--");
          const cmd = argv[argv.indexOf("--command") + 1];
          const shimArgs = argv.slice(sep + 1);
          const sockPath = shimArgs[1];
          const tidArg = shimArgs[3];

          // Scan both Node (/proc/self/mem) and HANDOFF_SERVER_PY (/proc/<handoff-pid>/mem & fd)
          // while HANDOFF_SERVER_PY is alive and waiting in srv.accept()!
          const handoffPid = findHandoffPidBySock(sockPath);
          const selfDuring = scanPidMem(process.pid);
          assert.ok(selfDuring.regions >= 20, `expected >= 20 regions scanned, got ${selfDuring.regions}`);
          assert.equal(selfDuring.emptyReads, 0, "expected 0 empty reads on /proc/self/mem");
          assert.ok(selfDuring.ctrlHits >= 1, `expected positive control in Node heap, got ${selfDuring.ctrlHits}`);
          assert.equal(selfDuring.tokHits, 0, "Node V8 heap must hold 0 token copies during handoff accept window");

          const sockMid = Math.floor(sockPath.length / 2);
          const tidMid = Math.floor(tidArg.length / 2);
          const handoffDuring = scanPidMem(handoffPid, {
            sockHead: Buffer.from(sockPath.slice(0, sockMid), "utf8"),
            sockTail: Buffer.from(sockPath.slice(sockMid), "utf8"),
            tidHead: Buffer.from(tidArg.slice(0, tidMid), "utf8"),
            tidTail: Buffer.from(tidArg.slice(tidMid), "utf8"),
          });
          assert.ok(handoffDuring.regions >= 10, `expected >= 10 regions in handoff child, got ${handoffDuring.regions}`);
          assert.equal(handoffDuring.readErrors, 0, "expected 0 read errors on /proc/<handoff-pid>/mem");
          assert.equal(handoffDuring.emptyReads, 0, "expected 0 empty reads on /proc/<handoff-pid>/mem");
          assert.ok(
            handoffDuring.sockHits >= 1 && handoffDuring.tidHits >= 1,
            `expected runtime positive control (sockHits=${handoffDuring.sockHits}, tidHits=${handoffDuring.tidHits}) in handoff child`,
          );
          assert.equal(
            handoffDuring.tokHits,
            0,
            "HANDOFF_SERVER_PY must hold 0 token copies while waiting in srv.accept()",
          );

          let openCredFds = 0;
          for (const fdEntry of readdirSync(`/proc/${handoffPid}/fd`)) {
            try {
              const target = readlinkSync(`/proc/${handoffPid}/fd/${fdEntry}`);
              if (target.startsWith(credDir)) openCredFds++;
            } catch {}
          }
          assert.equal(openCredFds, 0, "HANDOFF_SERVER_PY must hold 0 open credential FDs during srv.accept()");
          duringAcceptChecked++;

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

    // 1. Exercise all 5 credential file formats (plus StartSpec.token validated token id on the 5th)
    for (let i = 0; i < variantIds.length; i++) {
      const k = variantIds[i];
      activeTokenId = i === variantIds.length - 1 ? variantIds[0] : k;
      const tid = `thread-${k}-12345678`;
      const wtCwd = `${stateDir}/worktrees/${tid}`;
      await herdr.start({
        name: `genie-${k}`,
        threadId: tid,
        ...(i === variantIds.length - 1 ? { token: k } : {}),
        configDir: cfgDir,
        cwd: wtCwd,
        paneCwd: cwdDir,
        args: ["-n", `genie-${k}`, "--session-id", "12345678-0000-4000-8000-000000000000"],
      });
      const recorded = JSON.parse(readFileSync(handoffOut, "utf8"));
      assert.equal(recorded.thread_id, tid);
      assert.equal(recorded.is_sock, true);
      assert.equal(recorded.tok_len, expectedLen, `variant ${k} tok_len mismatch`);
      assert.equal(recorded.tok_sha256, expectedSha256, `variant ${k} tok_sha256 mismatch`);
    }
    assert.equal(duringAcceptChecked, variantIds.length);

    // 2. Scan Node /proc/self/mem after all 5 launches, both before and after explicit V8 GC (P4: assert global.gc is a function)
    const selfAfterBeforeGc = scanPidMem(process.pid);
    assert.ok(selfAfterBeforeGc.regions >= 20);
    assert.equal(selfAfterBeforeGc.emptyReads, 0);
    assert.ok(selfAfterBeforeGc.ctrlHits >= 1);
    assert.equal(selfAfterBeforeGc.tokHits, 0, "Node V8 heap must hold 0 token copies after 5 launches (pre-GC)");

    assert.equal(typeof global.gc, "function", "Oracle 1 must run under node --expose-gc (GT3 P4)");
    global.gc!();
    const selfAfterPostGc = scanPidMem(process.pid);
    assert.ok(selfAfterPostGc.regions >= 20);
    assert.equal(selfAfterPostGc.emptyReads, 0);
    assert.ok(selfAfterPostGc.ctrlHits >= 1);
    assert.equal(selfAfterPostGc.tokHits, 0, "Node V8 heap must hold 0 token copies after 5 launches (post-GC)");

    // 3. Invalid credential files (empty, comment-only, empty-quoted, missing, symlink) and C5 path traversal /
    // absolute path token ids must fail fast BEFORE ensureBasePane / herdr pane split is ever called.
    writeFileSync(`${credDir}/tier-token-empty`, "", { mode: 0o600 });
    writeFileSync(`${credDir}/tier-token-comment`, "# comment line\n   \n", { mode: 0o600 });
    writeFileSync(`${credDir}/tier-token-empty-quoted`, 'export CLAUDE_CODE_OAUTH_TOKEN=""\n', { mode: 0o600 });
    symlinkSync(`${credDir}/tier-token-kv`, `${credDir}/tier-token-symlink`);
    const outsideCred = `${outsideDir}/leaked-secret`;
    writeFileSync(outsideCred, "CLAUDE_CODE_OAUTH_TOKEN=outside-secret\n", { mode: 0o600 });

    const refusalCases: { tokenId: string; expectedErr: RegExp }[] = [
      { tokenId: "empty", expectedErr: /credential error: credential file contains no token/ },
      { tokenId: "comment", expectedErr: /credential error: credential file contains no token/ },
      { tokenId: "empty-quoted", expectedErr: /credential error: credential file contains no token/ },
      { tokenId: "does-not-exist", expectedErr: /credential error:/ },
      { tokenId: "symlink", expectedErr: /credential error:/ },
      { tokenId: outsideCred, expectedErr: /credential error: invalid/ },
      { tokenId: "../outside/leaked-secret", expectedErr: /credential error: invalid/ },
    ];

    for (const { tokenId, expectedErr } of refusalCases) {
      calls.length = 0;
      activeTokenId = tokenId;
      await assert.rejects(
        herdr.start({
          name: "genie-bad",
          threadId: "thread-bad",
          token: tokenId,
          configDir: cfgDir,
          cwd: `${stateDir}/worktrees/thread-bad`,
          paneCwd: cwdDir,
          args: ["--resume", "12345678-0000-4000-8000-000000000000"],
        }),
        expectedErr,
        `expected ${expectedErr} for tokenId=${tokenId}`,
      );
      assert.deepEqual(
        calls,
        [],
        `invalid credential tokenId=${tokenId} must fail before ensureBasePane or pane split is called`,
      );
    }
  },
);
