// How the supervisor starts a thread's tier 1 (plan C3.1): pi in RPC mode with only C1's
// extension, tier 1's prompt, and C2's skills seeded into the system prompt. pi's own skills list
// a skill's path for the model to `read`, and C1 confines `read` to worktrees, so each body goes in
// through `--append-system-prompt` instead. pi's own discovery of extensions, skills, prompt
// templates and context files is off.
import { readdirSync, readFileSync } from "node:fs";
import type { Launch } from "../supervisor/index.ts";
import { CONFIG_ENV } from "./extension.ts";
import { type Config, memoryPrompt } from "./index.ts";

export { memoryPrompt };

const repo = new URL("../../", import.meta.url);

// Every skill under dir, in name order, as tier 1's system prompt carries it.
export function skillsPrompt(dir = new URL("skills", repo).pathname): string {
  const skills = readdirSync(dir)
    .sort()
    .map((d) => `<skill name="${d}">\n${readFileSync(`${dir}/${d}/SKILL.md`, "utf8")}</skill>`);
  return `# Skills\n\n${skills.join("\n\n")}\n`;
}

export function tier1Launch(o: {
  pi: string;
  // The thread's Config, handed to the extension in its env.
  config: (thread: string) => Config;
  // More pi arguments for the thread: its session (P2's sessionArgs), its model.
  args?: (thread: string) => string[];
  // If true, seeds memoryPrompt into the system prompt. Default: false.
  memory?: boolean;
  memoryPath?: string;
}): Launch {
  const appendPrompts = [skillsPrompt()];
  if (o.memory) {
    appendPrompts.push(memoryPrompt(o.memoryPath));
  }
  const fixed = [
    "--mode", "rpc",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "-e", new URL("src/tier1/extension.ts", repo).pathname,
    "--system-prompt", new URL("prompts/tier1.md", repo).pathname,
    ...appendPrompts.flatMap((p) => ["--append-system-prompt", p]),
  ];
  return (thread) => ({
    command: o.pi,
    args: [...fixed, ...(o.args?.(thread) ?? [])],
    env: { [CONFIG_ENV]: JSON.stringify(o.config(thread)) },
  });
}
