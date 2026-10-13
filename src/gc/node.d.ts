// The node APIs collection uses beyond the other src/*/node.d.ts, declared here rather than pulling
// in @types/node.
declare module "node:child_process" {
  export function execFileSync(file: string, args: string[]): unknown;
}
