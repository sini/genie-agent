import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { relative } from "node:path";
import { executable } from "../src/isolation.ts";
import { piAiPath } from "../src/tier1/custody.ts";
import { runEval } from "../src/eval/run.ts";
import { stubModel } from "./fixtures/supervisor/stub-model.ts";

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-portable-baseline-`);
const pi = process.env.PI ?? executable("pi")!;
const nix = process.env.NIX_BIN ?? executable("nix")!;

// A real child has a test extension recording its own state; no Linux /proc is used.
test("portable baseline: actual Root and pi keep credentials in root without bwrap", { timeout: 30000 }, async () => {
  const key = "portable-root-model-canary";
  const model = await stubModel({ apiKey: key });
  const rootModule = process.env.GENIE_ROOT_MODULE ?? pathToFileURL(new URL("../src/root/index.ts", import.meta.url).pathname).href;
  const { main } = await import(rootModule);
  const dir = `${tmp}/root`; mkdirSync(dir);
  const wrapper = `${dir}/pi-wrapper`;
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(pi)} -e ${shellQuote(new URL("./fixtures/portable-probe.ts", import.meta.url).pathname)} "$@"\n`); chmodSync(wrapper, 0o755);
  writeFileSync(`${dir}/model-key`, key);
  const config = `${dir}/config.json`;
  writeFileSync(config, JSON.stringify({ stateRoot: `${dir}/state`, storeRoot: `${dir}/archive`, mirror: { mirrorRoot: `${dir}/mirrors`, worktreeRoot: `${dir}/worktrees` }, pi: wrapper,
    model: { baseUrl: model.url, api: "openai-completions", id: "m", keyFile: `${dir}/model-key` },
    tier1: { searxngUrl: "http://127.0.0.1:1", cluster: [], sandbox: { bwrap: `${dir}/absent-bwrap` } },
    guard: { enable: false }, broker: { guardOut: { enable: false } }, s3: null }));
  const batches: any[][] = [], evals: any[] = [];
  const oldSdk = process.env.GENIE_PI_AI, oldSecret = process.env.ROOT_ONLY_CREDENTIAL;
  process.env.GENIE_PI_AI ??= piAiPath(pi); process.env.ROOT_ONLY_CREDENTIAL = key;
  const root = main(config, { intake: { next: async () => batches.shift() ?? null }, post: { post: async () => {} }, xmsg: { send: async () => "sent" } }, async (launch: any) => { evals.push(launch); return { exit: 0, stdout_tail: "42", stderr_tail: "", limit_hit: "none" }; });
  try {
    const prompt = JSON.stringify({ tool: "eval", args: { repo: "owner/repo", rev: "main", attr: "value", trusted: "no" } });
    batches.push([{ thread: "portable", envelope: `[matrix] room=#support:example.org thread=$root user=caller (public)\n\n<request>\n${JSON.stringify({ sender: "caller", sender_id: "@caller:example.org", tier: "public", text: prompt })}\n</request>` }]);
    await root.run();
    for (let i = 0; i < 100 && model.requests.length < 2; i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(model.requests.length >= 2, "real pi must complete its model/tool/model turn");
    assert.ok(model.authentications.every(auth => auth === `Bearer ${key}`));
    assert.equal(evals.length, 1);
    const probe = JSON.parse(readFileSync(`${root.store.dir("portable")}/session/portable-probe.json`, "utf8"));
    assert.ok(!JSON.stringify(probe).includes(key), "actual pi argv/env disclosed root credential");
    assert.equal(probe.env.ROOT_ONLY_CREDENTIAL, undefined);
    assert.notEqual(probe.env.HOME, process.env.HOME);
    assert.notEqual(probe.env.HOME, probe.cwd);
    assert.equal(probe.env.PI_OFFLINE, "1");
    assert.ok(!readFileSync(`${probe.env.PI_CODING_AGENT_DIR}/models.json`, "utf8").includes(key));
  } finally {
    await root.stop(); model.close();
    if (oldSdk === undefined) delete process.env.GENIE_PI_AI; else process.env.GENIE_PI_AI = oldSdk;
    if (oldSecret === undefined) delete process.env.ROOT_ONLY_CREDENTIAL; else process.env.ROOT_ONLY_CREDENTIAL = oldSecret;
  }
});

test("portable baseline: native Nix evaluates with pure mode and a clean environment", { timeout: 30000 }, async () => {
  const dir = `${tmp}/eval`; mkdirSync(dir); mkdirSync(`${dir}/bin`);
  for (const [name, bin] of [["nix", nix], ["chmod", executable("chmod")!], ["sh", executable("sh")!], ["env", executable("env")!]]) symlinkSync(bin, `${dir}/bin/${name}`);
  const flake = `${dir}/flake #?%`; mkdirSync(flake);
  writeFileSync(`${flake}/flake.nix`, '{ outputs = _: { value = 42; home = builtins.getEnv "ROOT_ONLY_CREDENTIAL"; }; }');
  const linked = `${dir}/linked-source`; symlinkSync(dir, linked);
  const previous = process.env.PATH; process.env.PATH = `${dir}/bin`; process.env.ROOT_ONLY_CREDENTIAL = "must-not-be-in-eval";
  const reports: string[] = [];
  try {
    const result = await runEval({ sender_tier: "public", request: { attr: "value", trusted: "no" } }, { localFlake: relative(process.cwd(), `${linked}/flake #?%`), onStatus: s => reports.push(s), memoryMax: 256 * 1024 * 1024 });
    assert.equal(result.exit, 0, result.stderr_tail); assert.equal(result.stdout_tail.trim(), "42");
    const pure = await runEval({ sender_tier: "public", request: { attr: "home", trusted: "no" } }, { localFlake: flake, onStatus: s => reports.push(s) });
    assert.equal(pure.exit, 0, pure.stderr_tail); assert.equal(pure.stdout_tail.trim(), '""');
    assert.ok(reports.includes("baseline: credential custody, no OS isolation"));
    assert.ok(reports.some(s => s.startsWith("memory: requested=268435456, enforced=")));
    if (process.platform === "darwin") assert.ok(reports.some(s => s.startsWith("memory: requested=268435456, enforced=none (no delegated cgroup)")));
  } finally { process.env.PATH = previous; delete process.env.ROOT_ONLY_CREDENTIAL; }
});
