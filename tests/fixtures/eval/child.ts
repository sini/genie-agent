// One runEval in its own process, for the cells that need it under a narrower host than the suite's:
// no network, or a memory cap on the eval. Prints the eval-result as JSON.
// usage: node child.ts <attr> [<localFlake> [<memoryMax>]]; without a localFlake the request is a github
// coordinate. With a memoryMax the result also carries `memory_max`: each eval cgroup's memory.max, read
// while the eval runs, since the runner makes and caps the cgroup before it spawns anything.
import { readdirSync, readFileSync } from "node:fs";
import { runEval } from "../../../src/eval/run.ts";

const [attr, localFlake, memoryMax] = process.argv.slice(2);
const request = localFlake
  ? { repo: "local/fixture", rev: "limits", attr, trusted: "no" as const }
  : { repo: "NixOS/nixpkgs", rev: "nixos-unstable", attr, trusted: "no" as const };
const pending = runEval({ request, sender_tier: "public" }, { localFlake, timeoutMs: 60_000, memoryMax: memoryMax ? Number(memoryMax) : undefined });
let memory_max: string[] | undefined;
if (memoryMax) {
  // The runner has moved this process to a leaf beside its eval cgroups.
  const parent = `/sys/fs/cgroup${readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)\/[^/]*$/m)?.[1]}`;
  memory_max = readdirSync(parent)
    .filter((d) => d.startsWith("eval-"))
    .map((d) => readFileSync(`${parent}/${d}/memory.max`, "utf8").trim());
}
console.log(JSON.stringify({ ...(await pending), memory_max }));
