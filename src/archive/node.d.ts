// The node API the archive's SigV4 signer uses beyond the other src/*/node.d.ts, declared here
// rather than pulling in @types/node.
declare module "node:crypto" {
  export function createHmac(
    algorithm: string,
    key: string | Uint8Array,
  ): {
    update(data: string): { digest(): Uint8Array; digest(encoding: "hex"): string };
  };
}
