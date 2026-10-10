// The node APIs tier 1's tools use beyond the other src/*/node.d.ts, declared here rather than
// pulling in @types/node.
declare module "node:dns/promises" {
  export function lookup(
    hostname: string,
    options: { all: true; verbatim: boolean },
  ): Promise<{ address: string; family: number }[]>;
}
declare module "node:http" {
  interface IncomingMessage {
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: Uint8Array) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    destroy(): void;
  }
  interface ClientRequest {
    on(event: "timeout", listener: () => void): void;
    destroy(err?: Error): void;
  }
  type LookupCallback = (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void;
  interface GetOptions {
    headers: Record<string, string>;
    timeout: number;
    lookup: (hostname: string, options: { all?: boolean }, callback: LookupCallback) => void;
  }
  export function get(url: URL, options: GetOptions, callback: (res: IncomingMessage) => void): ClientRequest;
}
declare module "node:https" {
  import type { ClientRequest, GetOptions, IncomingMessage } from "node:http";
  export function get(url: URL, options: GetOptions, callback: (res: IncomingMessage) => void): ClientRequest;
}
declare module "node:net" {
  export function isIP(input: string): number;
  export class BlockList {
    addSubnet(network: string, prefix: number, type: "ipv4" | "ipv6"): void;
    check(address: string, type: "ipv4" | "ipv6"): boolean;
  }
}
declare module "node:path" {
  export function isAbsolute(path: string): boolean;
  export function resolve(...paths: string[]): string;
}
declare module "node:url" {
  export function fileURLToPath(url: URL): string;
}
