// The node APIs the mirror fetcher uses beyond the other src/*/node.d.ts, declared here rather than
// pulling in @types/node.
declare module "node:child_process" {
  export function spawn(
    command: string,
    args: string[],
    options: { env: Record<string, string | undefined>; detached: boolean; stdio: string[] },
  ): ChildProcess;
}
declare module "node:fs" {
  interface Dirent {
    name: string;
    parentPath: string;
  }
  export function readdirSync(path: string, options: { recursive: true; withFileTypes: true }): Dirent[];
  export function lstatSync(path: string): { size: number; blocks: number };
}
interface Process {
  kill(pid: number, signal: string): true;
}
