// The one node API the redactor uses, declared here rather than pulling in @types/node.
declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}
