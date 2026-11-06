// The node APIs the mirror fetcher uses beyond the other src/*/node.d.ts, declared here rather than
// pulling in @types/node.
interface Buffer extends Uint8Array {
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: "utf8"): string;
}
declare var Buffer: {
  from(data: string | Uint8Array, encoding?: "utf8"): Buffer;
  concat(list: readonly Uint8Array[], totalLength?: number): Buffer;
  isBuffer(obj: unknown): obj is Buffer;
};
declare module "node:child_process" {
  interface Readable {
    on(event: "data", listener: (chunk: Buffer) => void): void;
    pipe(destination: Writable): Writable;
  }
  interface Writable {
    write(data: string | Uint8Array): boolean;
  }
  export function spawn(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      detached?: boolean;
      stdio?: string[];
      timeout?: number;
      killSignal?: string;
    },
  ): ChildProcess;
}
declare module "node:fs" {
  interface Dirent {
    name: string;
    parentPath: string;
    isFile(): boolean;
  }
  interface Stats {
    size: number;
    blocks: number;
    mode: number;
    mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function chmodSync(path: string, mode: number): void;
  export function readdirSync(path: string, options: { recursive: true; withFileTypes: true }): Dirent[];
  export function lstatSync(path: string): Stats;
  export function lstatSync(path: string, options: { throwIfNoEntry: false }): Stats | undefined;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string): Buffer;
  export function rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): Stats;
  export function statSync(path: string, options: { throwIfNoEntry: false }): Stats | undefined;
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { mode?: number }): void;
}
interface Process {
  kill(pid: number, signal: string): true;
}
