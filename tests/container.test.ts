import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Custody, piAiPath } from "../src/tier1/custody.ts";
import { RootFileService, piToolsPath } from "../src/tier1/files.ts";
import { custodyCall } from "../src/tier1/socket.ts";
import { containerLaunch } from "../src/tier1/container.ts";
import { Supervisor, METHODS, type Record as PiRecord } from "../src/supervisor/index.ts";
import { stubModel } from "./fixtures/supervisor/stub-model.ts";
import { executable } from "../src/isolation.ts";

const pi = process.env.PI ?? "pi", sdk = piAiPath(pi);
const root = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-container-test-`);
const config = (thread: string) => ({ root: `${root}/${thread}`, memoryRoot: `${root}/memory`, searxngUrl: "http://127.0.0.1:1", cluster: [], maxScratchBytes: 12, maxScratchFiles: 2 });
const host = () => Object.fromEntries(METHODS.map((name) => [name, async () => name])) as any;
const model = { id: "m", api: "openai-completions", baseUrl: "http://root.invalid", apiKey: "root-only-container-canary" };
mkdirSync(`${root}/memory`); writeFileSync(`${root}/memory/MEMORY.md`, "memory corpus");

test("container files: root executes shipped tools with thread confinement, exact edit quota and read-only memory", async () => {
  for (const thread of ["files-a", "files-b"]) { mkdirSync(config(thread).root); writeFileSync(`${config(thread).root}/existing`, "alpha"); }
  const files = new Map(["files-a", "files-b"].map(t => [t, new RootFileService(config(t), piToolsPath(sdk))]));
  const custody = new Custody({ model, sdk, host, files: t => files.get(t)! });
  const socket = custody.open("files-a"), other = custody.open("files-b");
  try {
    const read = await custodyCall(socket, { method: "file", name: "read", arg: { path: "existing" } });
    assert.match(JSON.stringify(read), /alpha/);
    await assert.rejects(custodyCall(socket, { method: "file", name: "read", thread: "files-b", arg: { path: `${config("files-b").root}/existing` } }), /outside/);
    const memory = await custodyCall(socket, { method: "file", name: "read", arg: { path: "/memory/MEMORY.md" } });
    assert.match(JSON.stringify(memory), /memory corpus/);
    await assert.rejects(custodyCall(socket, { method: "file", name: "write", arg: { path: "/memory/MEMORY.md", content: "bad" } }), /read-only/);
    writeFileSync(`${config("files-b").root}/secret`, "must-not-leak-through-symlink");
    symlinkSync(config("files-b").root, `${config("files-a").root}/linked-credentials`);
    await assert.rejects(custodyCall(socket, { method: "file", name: "read", arg: { path: "linked-credentials/secret" } }), /outside/);
    for (const [name, arg] of [["grep", { pattern: "must-not-leak", path: "." }], ["find", { pattern: "*", path: "." }], ["ls", { path: "." }]] as const) {
      const result = await custodyCall(socket, { method: "file", name, arg });
      assert.doesNotMatch(JSON.stringify(result), /must-not-leak-through-symlink/);
    }
    await custodyCall(socket, { method: "file", name: "edit", arg: { path: "existing", edits: [{ oldText: "alpha", newText: "abcdef" }] } });
    await custodyCall(socket, { method: "file", name: "write", arg: { path: "new", content: "123456" } });
    await assert.rejects(custodyCall(socket, { method: "file", name: "edit", arg: { path: "existing", edits: [{ oldText: "abcdef", newText: "abcdefg" }] } }), /scratch byte quota/);
    assert.equal(readFileSync(`${config("files-a").root}/existing`, "utf8"), "abcdef");
    assert.equal(readFileSync(`${config("files-b").root}/existing`, "utf8"), "alpha");
    await custodyCall(other, { method: "file", name: "write", arg: { path: "new", content: "separate" } });
    await assert.rejects(custodyCall(socket, { method: "file", name: "write", arg: { path: "third", content: "" } }), /scratch file quota/);
  } finally { await custody.close(); }
});

test("container files: disconnected requests abort running work and queued requests cannot write", async () => {
  mkdirSync(`${root}/abort`);
  let reached: (() => void) | undefined, aborted: (() => void) | undefined;
  const running = new Promise<void>(resolve => { reached = resolve; });
  const ended = new Promise<void>(resolve => { aborted = resolve; });
  const files = { execute: async (_name: string, _input: unknown, signal: AbortSignal) => {
    reached!(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted!(); resolve(); }, { once: true }));
  } } as RootFileService;
  const custody = new Custody({ model, sdk, host, files: () => files });
  const socket = custody.open("abort"), child = connect(socket);
  child.write(`${JSON.stringify({ method: "file", name: "grep", arg: { pattern: "anything" } })}\n`);
  try {
    await running; child.destroy(); await ended;
    const actual = new RootFileService({ ...config("abort"), maxScratchBytes: 100 }, piToolsPath(sdk));
    const controller = new AbortController();
    let release: () => void = () => {};
    (actual as any).queue = new Promise<void>(r => { release = r; });
    const queued = actual.execute("write", { path: "refused", content: "bad" }, controller.signal);
    controller.abort(); release();
    await assert.rejects(queued, /aborted/);
    assert.equal(existsSync(`${root}/abort/refused`), false);
  } finally { child.destroy(); await custody.close(); }
});

test("container files: running SDK receives cancellation", { timeout: 3000 }, async () => {
  mkdirSync(`${root}/abort`, { recursive: true });
  const marker = `${root}/abort/marker`, fixture = `${root}/abort-sdk.mjs`;
  writeFileSync(fixture, `import {writeFileSync} from 'node:fs';
const factory=()=>({parameters:{type:'object'},execute:async(_id,arg,signal)=>{writeFileSync(arg.marker,'started');await new Promise(r=>signal.addEventListener('abort',r,{once:true}));writeFileSync(arg.marker,'aborted');return {content:[]};}});
export const createReadTool=factory,createWriteTool=factory,createEditTool=factory,createGrepTool=factory,createFindTool=factory,createLsTool=factory;`);
  const files = new RootFileService(config("abort"), fixture), controller = new AbortController();
  const request = files.execute("grep", { path: ".", marker }, controller.signal);
  for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(readFileSync(marker, "utf8"), "started");
  controller.abort();
  let timer: any;
  try {
    const completed = await Promise.race([request.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 300); })]);
    assert.equal(completed, true, "SDK work ignored request cancellation");
  } finally { clearTimeout(timer); }
  assert.equal(readFileSync(marker, "utf8"), "aborted");
});

test("container sessions: fixed captured destination, ordered chunks, atomic commit and abandoned cleanup", async () => {
  const dir = `${root}/sessions`; mkdirSync(dir);
  const custody = new Custody({ model, sdk, host, session: t => `${dir}/${t}.jsonl` });
  const socket = custody.open("a"), b = custody.open("b");
  writeFileSync(`${dir}/a.jsonl`, "old-session"); writeFileSync(`${dir}/b.jsonl`, "other-session");
  const call = (request: any) => custodyCall(socket, { method: "session", thread: "b", path: `${dir}/b.jsonl`, ...request });
  try {
    const first = await call({ op: "read", offset: 0 }); assert.equal(Buffer.from(first.data, "base64").toString(), "old-session");
    const { id } = await call({ op: "begin" });
    const data = Buffer.from("new-session 💬".repeat(12000));
    for (let pos = 0; pos < data.length; pos += 65536) await call({ op: "chunk", id, offset: pos, data: data.subarray(pos, pos + 65536).toString("base64") });
    assert.equal(readFileSync(`${dir}/a.jsonl`, "utf8"), "old-session");
    await assert.rejects(call({ op: "chunk", id, offset: 0, data: "" }), /invalid session chunk/);
    await assert.rejects(custodyCall(b, { method: "session", op: "commit", id, size: data.length }), /invalid session upload/);
    await call({ op: "commit", id, size: data.length });
    assert.equal(readFileSync(`${dir}/a.jsonl`, "utf8"), data.toString()); assert.equal(readFileSync(`${dir}/b.jsonl`, "utf8"), "other-session");
    await call({ op: "begin" }); await custody.closeThread("a");
    assert.deepEqual(readdirSync(dir).filter(x => x.includes("upload")), []);
  } finally { await custody.close(); }
});

test("container worker: actual packaged pi uses root files and model, persists before settlement and resumes", { timeout: 45000 }, async (t) => {
  const dir = `${root}/worker`; mkdirSync(dir); writeFileSync(`${dir}/content`, "root-worktree-content");
  const credential = `${root}/root-credential`; writeFileSync(credential, model.apiKey);
  const session = `${root}/worker-session.jsonl`, stopped = `${root}/stopped`, events: PiRecord[] = [];
  const upstream = await stubModel({ apiKey: model.apiKey });
  const cfg = { ...config("worker"), maxScratchBytes: 1000 };
  const files = new RootFileService(cfg, piToolsPath(sdk));
  const custody = new Custody({ model: { ...model, baseUrl: upstream.url }, sdk, host, files: () => files, session: () => session });
  const worker = resolve("src/tier1/container-worker.ts");
  const candidate = executable("bwrap"), marker = "container-namespace-positive-control";
  const probe = candidate && spawnSync(candidate, ["--unshare-user", "--unshare-pid", "--ro-bind", "/nix/store", "/nix/store", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--", process.execPath, "-e", `process.stdout.write(${JSON.stringify(marker)})`], { encoding: "utf8", timeout: 5000 });
  const bwrap = probe && probe.status === 0 && probe.stdout === marker ? candidate : undefined;
  if (process.env.GENIE_REQUIRE_CONTAINER_NAMESPACE === "1") assert.ok(bwrap, "namespace fixture requires usable bwrap");
  t.diagnostic(bwrap ? "worker namespace: Root worktree and credential absent; only socket state shared" : "worker portable command fixture: namespace unavailable");
  const command = bwrap ?? process.execPath;
  const args = bwrap ? ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--ro-bind", "/nix/store", "/nix/store", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", process.cwd(), process.cwd(), "--ro-bind", "{socketDir}", "/socket", "--chdir", "/tmp", "--", process.execPath, resolve("tests/fixtures/container-launch.mjs"), worker, dir, credential] : ["--experimental-strip-types", worker];
  const launch = (thread: string) => containerLaunch({ executor: { command, args, socketPath: bwrap ? "/socket/root.sock" : custody.open(thread), pi,
    repoRoot: process.cwd(), stop: { command: process.execPath, args: ["-e", "require('node:fs').appendFileSync(process.argv[1], JSON.stringify({secret:process.env.ROOT_ONLY_CREDENTIAL})+'\\n')", stopped] } },
    config: () => cfg, custody: t => ({ socket: custody.open(t), model: custody.publicModel, cleanup: () => custody.closeThread(t) }), screened: false })(thread);
  const prior = process.env.ROOT_ONLY_CREDENTIAL; process.env.ROOT_ONLY_CREDENTIAL = model.apiKey;
  const supervisor = new Supervisor(launch, (_t, r) => events.push(r));
  try {
    const ask = async () => {
      const before = events.length;
      const r = await supervisor.command("worker", { type: "prompt", message: JSON.stringify({ tool: "read", args: { path: "content" } }) });
      assert.equal(r.success, true, JSON.stringify(r));
      for (let i = 0; i < 200 && !events.slice(before).some(e => e.type === "agent_settled"); i++) await new Promise(r => setTimeout(r, 50));
      assert.ok(events.slice(before).some(e => e.type === "agent_settled"), "worker did not settle");
      assert.ok(existsSync(session), "settlement forwarded before root session persisted");
      assert.match(readFileSync(session, "utf8"), /root-worktree-content/);
    };
    await ask(); await supervisor.teardown("worker");
    if (bwrap) {
      const probe = events.find(e => e.type === "worker_namespace_probe");
      assert.equal(probe?.worktreeAbsent, true, "fixture shared the root worktree");
      assert.equal(probe?.credentialAbsent, true, "fixture shared the root credential");
    }
    const before = readFileSync(session, "utf8");
    await ask();
    assert.ok(readFileSync(session, "utf8").length > before.length, "worker restart lost prior session");
    assert.ok(upstream.authentications.every(x => x === `Bearer ${model.apiKey}`));
    assert.ok(!JSON.stringify(launch("worker")).includes(model.apiKey), "launcher received model key");
  } finally {
    await supervisor.shutdown(); await custody.close(); upstream.close();
    if (prior === undefined) delete process.env.ROOT_ONLY_CREDENTIAL; else process.env.ROOT_ONLY_CREDENTIAL = prior;
  }
  assert.ok(readFileSync(stopped, "utf8").split("\n").filter(Boolean).length >= 2, "explicit remote stop did not run");
  assert.doesNotMatch(readFileSync(stopped, "utf8"), /root-only-container-canary/);
});

test("container executor: startup failure and forced teardown run explicit stop before socket cleanup", { timeout: 5000 }, async () => {
  const fixture = `${root}/stubborn-worker.mjs`;
  writeFileSync(fixture, `let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{buf+=s;let n;while((n=buf.indexOf('\\n'))>=0){const r=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);if(r.id)process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true})+'\\n');}});setInterval(()=>{},1000);`);
  for (const failing of [true, false]) {
    const marker = `${root}/stop-${failing}`;
    const launch = containerLaunch({ executor: { command: failing ? `${root}/missing-executor` : process.execPath, args: [fixture], socketPath: "/socket/root.sock",
      stop: { command: process.execPath, args: ["-e", "require('node:fs').appendFileSync(process.argv[1],'stop '+process.argv[2]+'\\n')", marker, "{instance}"] } },
      config: () => config("worker"), custody: () => ({ socket: `${root}/root.sock`, model: { id: "m", api: "genie-custody", baseUrl: "http://root.invalid" }, cleanup: () => writeFileSync(marker, `${readFileSync(marker, "utf8")}socket-cleanup\n`) }) });
    const supervisor = new Supervisor(launch);
    if (failing) await assert.rejects(supervisor.command("lifecycle", { type: "prompt", message: "unused" }), /pi failed/);
    else { await supervisor.command("lifecycle", { type: "prompt", message: "unused" }); await supervisor.teardown("lifecycle", 0); }
    await supervisor.shutdown();
    for (let i = 0; i < 50 && (!existsSync(marker) || !readFileSync(marker, "utf8").includes("socket-cleanup")); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(existsSync(marker), "explicit remote stop did not run after executor exit");
    assert.match(readFileSync(marker, "utf8"), /^stop [0-9a-f-]+\nsocket-cleanup\n$/);
  }
});
