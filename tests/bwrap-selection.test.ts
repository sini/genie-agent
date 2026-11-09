import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { BWRAP_ISOLATION } from "../src/isolation.ts";
import { runEval } from "../src/eval/run.ts";
import { tier1Launch } from "../src/tier1/launch.ts";

const linux = { skip: process.platform !== "linux" && "Linux bwrap host adapter" };
const find = (name: string): string => {
  const file = (process.env.PATH ?? "").split(":").map((dir) => resolve(dir, name)).find(existsSync);
  assert.ok(file, `host adapter fixture requires ${name}`);
  return file;
};

// This control deliberately does not call usableBwrap: a broken selector must not skip its oracle.
function controlledBwrap(namespaces: string[] = []): string {
  const bwrap = find("bwrap");
  const probe = spawnSync(bwrap, [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--as-pid-1", ...namespaces,
    "--ro-bind", "/", "/", "--bind", "/proc", "/proc", "--", find("printf"), "%s", "bwrap-selection-control",
  ], { encoding: "utf8", timeout: 5000 });
  assert.equal(probe.status, 0, `host adapter namespace control failed: ${probe.stderr}`);
  assert.equal(probe.stdout, "bwrap-selection-control", "host adapter control must execute its payload");
  return bwrap;
}

test("usable bwrap selects BWRAP_ISOLATION for tier 1", linux, async () => {
  const bwrap = controlledBwrap();
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/bwrap-tier1-selection-`);
  const reports: string[] = [];
  let cleanup: (() => void | Promise<void>) | undefined;
  try {
    const spec = tier1Launch({
      pi: process.execPath,
      sandbox: { bwrap, stateRoot: `${tmp}/state`, worktreeRoot: `${tmp}/worktrees`, agentDir: `${tmp}/agent` },
      config: (thread) => ({ root: `${tmp}/worktrees/${thread}`, searxngUrl: "http://127.0.0.1:1", cluster: [] }),
      onStatus: (message) => reports.push(message),
    })("selector");
    cleanup = spec.cleanup;
    assert.deepEqual(reports, [BWRAP_ISOLATION], "usable bwrap must select tier-1 jail isolation");
    assert.equal(spec.command, bwrap, "tier-1 process must launch bwrap");
    assert.ok(spec.args.includes("--unshare-pid"));
    assert.equal(spec.inheritEnv, false);
  } finally {
    await cleanup?.();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("usable bwrap selects BWRAP_ISOLATION for eval", linux, async () => {
  const bwrap = controlledBwrap(["--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try"]);
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/bwrap-eval-selection-`);
  const reports: string[] = [];
  const originalPath = process.env.PATH;
  try {
    mkdirSync(`${tmp}/bin`);
    // The store-resident Node stand-in rejects Nix flags identically in either selector branch.
    symlinkSync(realpathSync(process.execPath), `${tmp}/bin/nix`);
    process.env.PATH = `${tmp}/bin:${originalPath ?? ""}`;
    const result = await runEval({ request: { attr: "value", trusted: "no" }, sender_tier: "public" }, {
      localFlake: tmp, bwrap, timeoutMs: 5000, onStatus: (message) => reports.push(message),
    });
    assert.deepEqual(reports, [BWRAP_ISOLATION], "usable bwrap must select eval jail isolation");
    assert.equal(result.exit, 9, "selected eval process must execute the Node stand-in");
    assert.match(result.stderr_tail, /bad option: --extra-experimental-features/);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(tmp, { recursive: true, force: true });
  }
});
