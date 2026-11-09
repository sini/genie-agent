// Tier 1 as pi loads it (`pi -e`, plan C3.1): C1's tools with the supervisor's Host. A Host call
// leaves this process as an RPC `input` dialog on pi's own stdout and its answer comes back on
// stdin, so the supervisor takes the thread from the pipes it arrived on. Nothing sent here names
// the thread.
import { BRIDGE, METHODS } from "../supervisor/index.ts";
import { CUSTODY_ENV, type CustodyConfig, hostCall, modelStream } from "./socket.ts";
import { type Config, type Host, type Pi, tier1 } from "./index.ts";

// The env var `launch` puts the thread's Config in.
export const CONFIG_ENV = "GENIE_TIER1_CONFIG";

export type Input = (title: string, placeholder?: string) => Promise<string | undefined>;

// A Host whose every call is a dialog answered by the supervisor: `{ok}` or `{error}`.
export function bridge(input: () => Input): Host {
  const call = async (method: string, arg: unknown) => {
    const answer = await input()(BRIDGE, JSON.stringify({ method, arg }));
    if (answer === undefined) throw new Error(`${method}: the supervisor did not answer`);
    const r = JSON.parse(answer);
    if (typeof r.error === "string") throw new Error(r.error);
    return r.ok;
  };
  return Object.fromEntries(METHODS.map((m) => [m, (arg: unknown) => call(m, arg)])) as unknown as Host;
}

export default function (pi: Pi): void {
  const raw = process.env[CONFIG_ENV];
  if (!raw) throw new Error(`${CONFIG_ENV} is not set`);
  let ui: { input: Input } | undefined;
  pi.on("session_start", async (_e, ctx) => {
    ui = ctx.ui;
  });
  const custody = process.env[CUSTODY_ENV] ? JSON.parse(process.env[CUSTODY_ENV]!) as CustodyConfig : undefined;
  if (custody) {
    if (!pi.registerProvider) throw new Error("pi does not support root model custody");
    pi.registerProvider("genie", {
      ...custody.model, apiKey: "root-custody-placeholder",
      models: [{ id: custody.model.id, name: custody.model.id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
      streamSimple: (model: any, context: unknown, options: any) => modelStream(custody.socket, model, context, options),
    });
  }
  const host = custody ? Object.fromEntries(METHODS.map((name) => [name, (arg: unknown) => hostCall(custody.socket, name, arg)])) as unknown as Host : bridge(() => {
    if (!ui) throw new Error("no session yet");
    return ui.input;
  });
  tier1(JSON.parse(raw) as Config, { host })(pi);
}
