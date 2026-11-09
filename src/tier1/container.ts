import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import type { Launch } from "../supervisor/index.ts";
import type { Config } from "./index.ts";
import { memoryPrompt } from "./index.ts";
import { skillsPrompt, UNSCREENED_PROMPT } from "./launch.ts";
import type { CustodyConfig } from "./socket.ts";

export interface ContainerExecutor {
  command: string;
  args: string[];
  socketPath: string;
  socketRoot?: string;
  pi?: string;
  repoRoot?: string;
  stop: { command: string; args: string[] };
}

export interface WorkerBootstrap {
  type: "genie-worker";
  config: Config;
  custody: CustodyConfig;
  pi?: string;
  repoRoot?: string;
  prompt: string;
  appendPrompts: string[];
}

export function containerLaunch(o: {
  executor: ContainerExecutor;
  config: (thread: string) => Config;
  custody: (thread: string) => CustodyConfig & { cleanup?: () => void | Promise<void> };
  memory?: boolean;
  memoryPath?: string;
  screened?: boolean;
  onStatus?: (message: string) => void;
}): Launch {
  return (thread) => {
    const config = o.config(thread);
    const prompt = readFileSync(process.env.GENIE_REPO_ROOT ? `${process.env.GENIE_REPO_ROOT}/prompts/tier1.md` : new URL("../../prompts/tier1.md", import.meta.url).pathname, "utf8");
    const appendPrompts = [skillsPrompt(), ...(o.memory ? [memoryPrompt(o.memoryPath)] : []), ...(o.screened === false ? [UNSCREENED_PROMPT] : [])];
    const custody = o.custody(thread), socketDir = dirname(custody.socket), instance = randomUUID();
    const substitute = (values: string[]) => values.map((v) => v.replaceAll("{socketDir}", socketDir).replaceAll("{instance}", instance));
    const bootstrap: WorkerBootstrap = {
      type: "genie-worker", config, pi: o.executor.pi, repoRoot: o.executor.repoRoot,
      custody: { socket: o.executor.socketPath, model: custody.model, remoteFiles: true },
      prompt, appendPrompts,
    };
    (o.onStatus ?? console.error)("container: credential custody, socket-only worker");
    return {
      command: o.executor.command, args: substitute(o.executor.args), inheritEnv: false, detached: true,
      env: { PATH: process.env.PATH ?? "/bin:/usr/bin" },
      initialInput: `${JSON.stringify(bootstrap)}\n`,
      cleanup: async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(o.executor.stop.command, substitute(o.executor.stop.args), { env: { PATH: process.env.PATH ?? "/bin:/usr/bin" }, stdio: ["ignore", "ignore", "ignore"], timeout: 5000, killSignal: "SIGKILL" });
            child.on("error", () => reject(new Error("container executor stop failed")));
            child.on("close", (code) => code === 0 ? resolve() : reject(new Error("container executor stop failed")));
          });
        } finally { await custody.cleanup?.(); }
      },
    };
  };
}
