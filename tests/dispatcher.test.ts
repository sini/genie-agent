// The dispatcher core's gating oracle (design oracle 24): a second escalation of a parked thread
// launches with --resume and its first launch's uuid, under the same token's config directory,
// including across a dispatcher kill and a restart from the journal. Run with
// `node --test tests/dispatcher.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  assert.deepEqual(readdirSync(o.stateDir), ["journal.json"]);
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
const cli = (replies: Record<string, string>) => {
  const calls: { argv: string[]; env: Record<string, string | undefined> }[] = [];
  const herdr = new CliHerdr({
    session: "public",
    basePane: "w1:p1",
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
    "pane split": ok({ pane: { pane_id: "w1:p7" } }),
    "agent start": ok({ type: "agent_started" }),
  });
  const pane = await herdr.start({ name: "genie-1", configDir: "/cfg/a", cwd: "/cwd", args: ["--resume", "u-1"] });
  assert.equal(pane, "w1:p7");
  assert.deepEqual(
    calls.map((c) => c.argv),
    [
      ["herdr", "--session", "public", "pane", "split", "w1:p1", "--direction", "right", "--cwd", "/cwd",
        "--env", "CLAUDE_CONFIG_DIR=/cfg/a", "--no-focus"],
      ["herdr", "--session", "public", "agent", "start", "genie-1", "--kind", "claude", "--pane", "w1:p7",
        "--timeout", "60000", "--", "--resume", "u-1"],
    ],
  );
  assert.equal(calls[0].env.HERDR_SOCKET_PATH, undefined);
});

test("the cli adapter closes the pane when claude does not start", async () => {
  const { herdr, calls } = cli({
    "pane split": ok({ pane: { pane_id: "w1:p7" } }),
    "agent start error": '{"error":{"code":"agent_not_ready"}}',
    "pane close": ok({ type: "ok" }),
  });
  await assert.rejects(herdr.start({ name: "n", configDir: "/c", cwd: "/w", args: [] }), /agent_not_ready/);
  assert.deepEqual(calls[2].argv, ["herdr", "--session", "public", "pane", "close", "w1:p7"]);
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
