// The node APIs the supervisor uses beyond the other src/*/node.d.ts, declared here rather than
// pulling in @types/node.
declare module "node:child_process" {
  interface Readable {
    setEncoding(encoding: "utf8"): void;
  }
  interface Writable {
    write(chunk: string): boolean;
    end(): void;
    on(event: "error", listener: (err: Error) => void): void;
  }
  interface ChildProcess {
    pid?: number;
    stdin: Writable;
    kill(signal?: string): boolean;
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): ChildProcess;
  }
}
