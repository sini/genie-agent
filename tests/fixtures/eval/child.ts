// One runEval in its own process, for the cells that need it under a narrower host than the suite's:
// no network, or a memory-capped scope. Prints the eval-result as JSON.
// usage: node child.ts <attr> [<localFlake>]; without a localFlake the request is a github coordinate.
import { runEval } from "../../../src/eval/run.ts";

const [attr, localFlake] = process.argv.slice(2);
const request = localFlake
  ? { repo: "local/fixture", rev: "limits", attr, trusted: "no" as const }
  : { repo: "NixOS/nixpkgs", rev: "nixos-unstable", attr, trusted: "no" as const };
console.log(JSON.stringify(await runEval({ request, sender_tier: "public" }, { localFlake, timeoutMs: 60_000 })));
