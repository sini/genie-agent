import { accessSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTINS, confine, confineWrite, type Config, DEFAULT_MAX_SCRATCH_BYTES, DEFAULT_MAX_SCRATCH_FILES } from "./index.ts";
import { errors } from "./schema.ts";

export function piToolsPath(piAi: string): string {
  return resolve(dirname(piAi), "../../../..", "dist/index.js");
}

// The SDK does parsing, image handling, search, and edit matching; root owns paths and writes.
export class RootFileService {
  private tools: Promise<Record<string, any>> | undefined;
  private ledger = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private config: Config;
  private sdk: string | (() => string);
  constructor(config: Config, sdk: string | (() => string)) { this.config = config; this.sdk = sdk; }

  private async load(): Promise<Record<string, any>> {
    const sdk = await import(pathToFileURL(typeof this.sdk === "function" ? this.sdk() : this.sdk).href);
    const write = async (raw: string, content: string) => {
      const file = confineWrite(this.config.root, raw, { memoryRoot: this.config.memoryRoot });
      const bytes = new TextEncoder().encode(content).byteLength;
      if (!this.ledger.has(file) && this.ledger.size >= (this.config.maxScratchFiles ?? DEFAULT_MAX_SCRATCH_FILES)) throw new Error("refused: scratch file quota exceeded");
      const total = [...this.ledger.values()].reduce((a, b) => a + b, 0) - (this.ledger.get(file) ?? 0) + bytes;
      if (total > (this.config.maxScratchBytes ?? DEFAULT_MAX_SCRATCH_BYTES)) throw new Error("refused: scratch byte quota exceeded");
      writeFileSync(file, content);
      this.ledger.set(file, bytes);
    };
    const mkdir = async (dir: string) => {
      const file = confineWrite(this.config.root, `${dir}/.genie-directory`, { memoryRoot: this.config.memoryRoot });
      mkdirSync(dirname(file), { recursive: true });
    };
    const root = this.config.root;
    return {
      read: sdk.createReadTool(root), grep: sdk.createGrepTool(root), find: sdk.createFindTool(root), ls: sdk.createLsTool(root),
      write: sdk.createWriteTool(root, { operations: { writeFile: write, mkdir } }),
      edit: sdk.createEditTool(root, { operations: { writeFile: write, readFile: async (p: string) => readFileSync(confineWrite(root, p, { requireExisting: true })), access: async (p: string) => accessSync(confineWrite(root, p, { requireExisting: true })) } }),
    };
  }

  execute(name: string, input: unknown, signal = new AbortController().signal): Promise<unknown> {
    const run = this.queue.then(async () => {
      if (signal.aborted) throw new Error("file request aborted");
      if (!(BUILTINS as readonly string[]).includes(name)) throw new Error("unknown file tool");
      const tools = await (this.tools ??= this.load());
      const tool = tools[name];
      const arg = { ...(input as Record<string, unknown>) };
      if (name === "edit" && typeof arg.oldText === "string" && typeof arg.newText === "string") {
        arg.edits = [...(Array.isArray(arg.edits) ? arg.edits : []), { oldText: arg.oldText, newText: arg.newText }]; delete arg.oldText; delete arg.newText;
      }
      const bad = errors(tool.parameters, arg);
      if (bad.length) throw new Error(`invalid ${name} arguments: ${bad.join("; ")}`);
      arg.path = name === "write" || name === "edit"
        ? confineWrite(this.config.root, arg.path, { memoryRoot: this.config.memoryRoot, requireExisting: name === "edit" })
        : confine(this.config.root, arg.path ?? this.config.root, this.config.memoryRoot);
      if (signal.aborted) throw new Error("file request aborted");
      return tool.execute("root-file", arg, signal);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
