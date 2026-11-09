import { writeFileSync } from "node:fs";
export default function (): void {
  const i = process.argv.indexOf("--session-dir");
  if (i >= 0) writeFileSync(`${process.argv[i + 1]}/portable-probe.json`, JSON.stringify({ argv: process.argv, env: { ROOT_ONLY_CREDENTIAL: process.env.ROOT_ONLY_CREDENTIAL, HOME: process.env.HOME, PI_OFFLINE: process.env.PI_OFFLINE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }, cwd: process.cwd() }));
}
