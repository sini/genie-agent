// The node APIs the dispatcher uses beyond src/eval/node.d.ts, declared here rather than pulling
// in @types/node.
declare module "node:child_process" {
  export function execFile(
    file: string,
    args: string[],
    options: { env: Record<string, string | undefined> },
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ): void;
}
declare module "node:crypto" {
  export function randomUUID(): string;
}
declare module "node:fs" {
  export function closeSync(fd: number): void;
  export function fsyncSync(fd: number): void;
  export function mkdirSync(path: string, options: { recursive: boolean; mode: number }): void;
  export function openSync(path: string, flags: string, mode?: number): number;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function renameSync(from: string, to: string): void;
  export function writeSync(fd: number, data: string): number;
}
