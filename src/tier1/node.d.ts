// The node APIs tier 1's tools use beyond the other src/*/node.d.ts, declared here rather than
// pulling in @types/node.
interface Buffer {
  toString(encoding: "base64"): string;
}
declare module "node:buffer" {
  export const Buffer: {
    from(data: string | Uint8Array, encoding?: "utf8" | "base64"): Buffer;
    concat(list: readonly Uint8Array[]): Buffer;
  };
}
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
declare module "node:fs" {
  export function accessSync(path: string): void;
  export function appendFileSync(path: string, data: Uint8Array): void;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  export function fstatSync(fd: number): { isFile(): boolean; size: number };
  interface Dirent {
    isDirectory(): boolean;
  }
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function statSync(path: string): { size: number; blocks: number; mode: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; mtimeMs: number };
}
declare module "node:path" {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}
declare module "node:url" {
  export function fileURLToPath(url: URL): string;
  export function pathToFileURL(path: string): URL;
}
