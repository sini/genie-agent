// An eval SIGKILLed from outside the runner, in its own process so it can run under a narrower host.
// With "oom" first, a concurrent eval in the same runner runs out of memory before the kill.
// Prints the killed eval's eval-result as JSON. usage: node kill.ts <limits flake> [oom]
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { runEval } from "../../../src/eval/run.ts";

const [flake, first] = process.argv.slice(2);
const run = (attr: string) =>
  runEval({ request: { repo: "local/fixture", rev: "limits", attr, trusted: "no" }, sender_tier: "public" }, {
    localFlake: flake,
    timeoutMs: 120_000,
  });

// Whether pid is a descendant of this process, so no other run's nix is ever killed.
const descends = (pid: string): boolean => {
  for (let p = pid; Number(p) > 1; ) {
    p = readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" ")[1];
    if (Number(p) === process.pid) return true;
  }
  return false;
};

const spin = run("spin");
let nix = 0;
spin.finally(() => nix || (nix = -1));
while (!nix) {
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("path:/src#spin") || !descends(pid)) continue;
      if (readlinkSync(`/proc/${pid}/exe`).endsWith("/bin/nix")) nix = Number(pid);
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 50));
}
if (nix < 0) throw new Error(`spin ended before it was seen: ${JSON.stringify(await spin)}`);
if (first) {
  // Stopped while still small, so the OOM killer picks the other eval.
  process.kill(nix, "SIGSTOP");
  const r = await run(first);
  if (r.limit_hit !== first) throw new Error(`the ${first} eval was ${r.limit_hit}: ${r.stderr_tail}`);
}
process.kill(nix, "SIGKILL");
console.log(JSON.stringify(await spin));
