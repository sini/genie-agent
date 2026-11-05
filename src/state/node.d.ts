// The node APIs the state reader uses beyond the other src/*/node.d.ts, declared here rather than
// pulling in @types/node.
declare module "node:fs" {
  export const constants: {
    O_RDONLY: number;
    O_NONBLOCK: number;
    O_NOFOLLOW: number;
  };
  export function fstatSync(fd: number): { isFile(): boolean };
  export function openSync(path: string, flags: string | number): number;
  export function readFileSync(path: string | number, encoding: "utf8"): string;
}
