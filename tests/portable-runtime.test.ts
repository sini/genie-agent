import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { usableBwrap } from "../src/isolation.ts";
import { tier1Launch } from "../src/tier1/launch.ts";

const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/portable-runtime-`);
test("portable adapter detection requires an executed payload, not an existing binary", () => {
  const fake = `${tmp}/bwrap`;
  writeFileSync(fake, "#!/bin/sh\nexit 0\n"); chmodSync(fake, 0o755);
  assert.equal(usableBwrap(fake), undefined);
  assert.equal(usableBwrap(`${tmp}/absent`), undefined);
});
test("portable pi baseline has a private home, clean environment and an explicit isolation report", async () => {
  const reports: string[] = [];
  let cleanup: (() => void | Promise<void>) | undefined;
  const before = process.env.ROOT_ONLY_CREDENTIAL;
  process.env.ROOT_ONLY_CREDENTIAL = "root-only-test-value";
  try {
    const launch = tier1Launch({ pi: process.execPath, sandbox: { bwrap: `${tmp}/absent` }, config: () => ({ root: `${tmp}/work`, searxngUrl: "http://127.0.0.1:1", cluster: [] }), onStatus: (s) => reports.push(s) });
    const spec = launch("baseline");
    cleanup = spec.cleanup;
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.inheritEnv, false);
    assert.equal(spec.detached, true);
    assert.equal(spec.cwd, `${tmp}/work`);
    assert.notEqual(spec.env?.HOME, spec.cwd);
    assert.ok(spec.env?.HOME?.startsWith(tmp) === false);
    assert.ok(!JSON.stringify(spec).includes("root-only-test-value"));
    assert.ok(reports.includes("baseline: credential custody, no OS isolation"));
  } finally { await cleanup?.(); if (before === undefined) delete process.env.ROOT_ONLY_CREDENTIAL; else process.env.ROOT_ONLY_CREDENTIAL = before; }
});

test("portable eval uses native paths, a clean home and no false memory enforcement", async () => {
  const { runEval } = await import("../src/eval/run.ts");
  const { symlinkSync, mkdirSync, readFileSync } = await import("node:fs");
  const reports: string[] = [];
  const bin = `${tmp}/bin`, flake = `${tmp}/flake`;
  mkdirSync(bin); mkdirSync(flake);
  const record = `${tmp}/eval-record.json`;
  const nix = `${bin}/nix`;
  writeFileSync(nix, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({argv:process.argv.slice(2),env:{ROOT_ONLY_CREDENTIAL:process.env.ROOT_ONLY_CREDENTIAL,HOME:process.env.HOME,NIX_PATH:process.env.NIX_PATH},conf:require('node:fs').existsSync(process.env.NIX_CONF_DIR+'/nix.conf')?require('node:fs').readFileSync(process.env.NIX_CONF_DIR+'/nix.conf','utf8'):null}));process.stdout.write('42');\n`);
  chmodSync(nix, 0o755);
  const { executable } = await import("../src/isolation.ts");
  for (const name of ["chmod", "sh", "env"]) symlinkSync(executable(name)!, `${bin}/${name}`);
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  process.env.ROOT_ONLY_CREDENTIAL = "root-only-test-value";
  try {
    const result = await runEval({ request: { attr: "value", trusted: "no" }, sender_tier: "public" }, { localFlake: flake, memoryMax: 128 * 1024 * 1024, onStatus: (s) => reports.push(s) });
    assert.equal(result.exit, 0);
    assert.equal(result.stdout_tail, "42");
    const observed = JSON.parse(readFileSync(record, "utf8"));
    assert.ok(observed.argv.includes(`path:${flake}#value`));
    assert.equal(observed.env.ROOT_ONLY_CREDENTIAL, undefined);
    assert.equal(observed.env.NIX_PATH, "");
    assert.notEqual(observed.env.HOME, "/work/home");
    assert.equal(observed.conf, null, "native Nix sandbox settings must not be disabled");
    assert.ok(reports.includes("baseline: credential custody, no OS isolation"));
    assert.ok(reports.some((s) => s.includes("requested=134217728, enforced=")));
  } finally { process.env.PATH = oldPath; delete process.env.ROOT_ONLY_CREDENTIAL; }
});

test("portable eval timeout terminates its owned process group", async () => {
  const { runEval } = await import("../src/eval/run.ts");
  const { executable } = await import("../src/isolation.ts");
  const { symlinkSync, mkdirSync, readFileSync } = await import("node:fs");
  const dir = `${tmp}/timeout`, bin = `${dir}/bin`, marker = `${dir}/child-pid`;
  mkdirSync(bin, { recursive: true });
  for (const name of ["chmod", "sh", "env"]) symlinkSync(executable(name)!, `${bin}/${name}`);
  writeFileSync(`${bin}/nix`, `#!${process.execPath}\nconst c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);\n`);
  chmodSync(`${bin}/nix`, 0o755);
  const previous = process.env.PATH; process.env.PATH = bin;
  let pid: number | undefined;
  try {
    const result = await runEval({ sender_tier: "public", request: { attr: "x", trusted: "no" } }, { localFlake: dir, timeoutMs: 100, onStatus: () => {} });
    assert.equal(result.exit, 124); assert.equal(result.limit_hit, "timeout");
    pid = Number(readFileSync(marker, "utf8"));
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) { try { process.kill(pid, 0); } catch { alive = false; } if (alive) await new Promise(r => setTimeout(r, 10)); }
    assert.equal(alive, false, "owned eval descendant remained after timeout");
    pid = undefined;
  } finally {
    process.env.PATH = previous;
    if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
  }
});

test("portable supervisor cleans descendants on normal and unexpected pi exit", async () => {
  const { Supervisor } = await import("../src/supervisor/index.ts");
  const { readFileSync } = await import("node:fs");
  const script = `${tmp}/exit-with-child.cjs`;
  writeFileSync(script, `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(process.argv[2],String(child.pid));let buf='';process.stdin.on('data',chunk=>{buf+=chunk;let i;while((i=buf.indexOf('\\n'))>=0){const c=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true})+'\\n');if(c.type==='exit-now')setTimeout(()=>process.exit(0),10);}});process.stdin.on('end',()=>process.exit(0));`);
  const leaked: string[] = [];
  for (const mode of ["normal", "unexpected"]) {
    const marker = `${tmp}/${mode}-descendant`;
    const supervisor = new Supervisor(() => ({ command: process.execPath, args: [script, marker], env: {}, inheritEnv: false, detached: true }));
    let descendant: number | undefined;
    try {
      await supervisor.command(mode, { type: mode === "normal" ? "ready" : "exit-now" });
      descendant = Number(readFileSync(marker, "utf8"));
      if (mode === "normal") await supervisor.teardown(mode, 100);
      else for (let i = 0; i < 100 && supervisor.threads().includes(mode); i++) await new Promise(r => setTimeout(r, 10));
      let alive = true;
      for (let i = 0; i < 100 && alive; i++) { try { process.kill(descendant, 0); } catch { alive = false; } if (alive) await new Promise(r => setTimeout(r, 10)); }
      if (alive) leaked.push(mode);
      else descendant = undefined;
    } finally {
      await supervisor.shutdown();
      if (descendant) try { process.kill(descendant, "SIGKILL"); } catch {}
    }
  }
  assert.deepEqual(leaked, [], "pi exit left owned descendants alive");
});
