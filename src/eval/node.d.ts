// The node APIs the eval runner uses, declared here rather than pulling in @types/node.
declare module "node:child_process" {
  interface Readable {
    on(event: "data", listener: (chunk: string) => void): void;
  }
  interface ChildProcess {
    stdout: Readable;
    stderr: Readable;
    on(event: "error", listener: (err: Error) => void): ChildProcess;
    on(event: "close", listener: (code: number | null) => void): ChildProcess;
  }
  export function spawn(
    command: string,
    args: string[],
    options?: { stdio?: string[]; timeout?: number; killSignal?: string },
  ): ChildProcess;
}
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function realpathSync(path: string): string;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}
declare var process: { env: Record<string, string | undefined> };
