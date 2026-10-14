// Node APIs used by bank queue and review CLI beyond other node.d.ts files.

declare module "node:path" {
  export function join(...paths: string[]): string;
  const path: {
    join(...paths: string[]): string;
    isAbsolute(path: string): boolean;
    resolve(...paths: string[]): string;
  };
  export default path;
}

declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
  export function unlinkSync(path: string): void;
}

interface Process {
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
}
