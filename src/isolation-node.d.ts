declare module "node:child_process" {
  export function spawnSync(command: string, args: string[], options: { env?: Record<string, string>; encoding: "utf8"; timeout: number }): { status: number | null; stdout: string; stderr: string };
}
interface Process {
  platform: string;
  execPath: string;
}
