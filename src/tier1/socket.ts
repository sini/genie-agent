import { connect } from "node:net";

export const CUSTODY_ENV = "GENIE_CUSTODY";
export interface PublicModel { id: string; api: string; baseUrl: string }
export interface CustodyConfig { socket: string; model: PublicModel; sdk?: string }
export interface ModelEvent { type: string; [name: string]: any }

async function* records(socket: string, request: unknown, signal?: AbortSignal): AsyncGenerator<any> {
  const c = connect(socket);
  const abort = () => c.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new Error("model request aborted");
    c.write(`${JSON.stringify(request)}\n`);
    let buf = "";
    for await (const chunk of c) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const value = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (typeof value.error === "string") throw new Error(value.error);
        yield value;
      }
    }
  } finally { signal?.removeEventListener("abort", abort); c.destroy(); }
}

export async function hostCall(socket: string, name: string, arg: unknown): Promise<any> {
  for await (const r of records(socket, { method: "host", name, arg })) return r.ok;
  throw new Error("root did not answer Host request");
}

// The client receives normalized SDK events; no provider HTTP request or credential runs here.
export function modelStream(socket: string, model: any, context: unknown, options: any = {}): AsyncIterable<ModelEvent> & { result(): Promise<any> } {
  let finish: (value: any) => void = () => {};
  const result = new Promise<any>((resolve) => { finish = resolve; });
  const signal = options.signal as AbortSignal | undefined;
  const serializable = Object.fromEntries(Object.entries(options).filter(([k, v]) => k !== "signal" && typeof v !== "function"));
  let consumed = false;
  return {
    result: () => result,
    async *[Symbol.asyncIterator]() {
      if (consumed) throw new Error("model stream already consumed");
      consumed = true;
      let complete = false;
      try {
        for await (const r of records(socket, { method: "model", context, options: serializable }, signal)) {
          const e = r.event as ModelEvent;
          if (e.type === "done" || e.type === "error") { finish(e.message ?? e.error); complete = true; }
          yield e;
        }
        if (!complete) throw new Error(signal?.aborted ? "model request aborted" : "root model stream ended early");
      } catch (error) {
        const message = {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : "root model request failed", timestamp: Date.now(),
        };
        finish(message);
        yield { type: "error", reason: message.stopReason, error: message };
      }
    },
  };
}
