import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import process from "node:process";

export interface XmsgEndpoints {
  agentSocket: string;
  registerSocket: string;
  httpSocket: string;
}

export interface XmsgEndpointOverrides extends Partial<XmsgEndpoints> {
  xmsgDir?: string;
}

export const xmsgEndpointFlags = { "--xmsg-dir": "xmsgDir", "--agent-sock": "agentSocket",
  "--register-sock": "registerSocket", "--http-sock": "httpSocket" } as const;

export function xmsgEndpointArguments(flags: Map<string, string>): XmsgEndpointOverrides {
  const result: XmsgEndpointOverrides = {};
  for (const [flag, name] of Object.entries(xmsgEndpointFlags)) {
    const value = flags.get(flag);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

export type XmsgEndpointResolver = (overrides?: XmsgEndpointOverrides) => Promise<XmsgEndpoints>;
type ProbeError = Error & { code?: string | number; killed?: boolean; signal?: string | null };
export interface DoctorResult { stdout: string; error?: ProbeError | null }
export interface DoctorOptions {
  env: Record<string, string | undefined>;
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  shell: false;
  killSignal: "SIGKILL";
}
export type DoctorProbe = (file: string, args: string[], options: DoctorOptions) => Promise<DoctorResult>;

export class XmsgEndpointError extends Error {}

const names = ["agentSocket", "registerSocket", "httpSocket"] as const;
const environmentNames = {
  agentSocket: "XMSG_AGENT_SOCK",
  registerSocket: "XMSG_REGISTER_SOCK",
  httpSocket: "XMSG_HTTP_SOCK",
} as const;
const fileNames = { agentSocket: "agent.sock", registerSocket: "register.sock", httpSocket: "http.sock" } as const;

function socket(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new XmsgEndpointError(`xmsg: ${field} must be an absolute socket path`);
  }
  return value;
}

export function explicitXmsgEndpoints(overrides: XmsgEndpointOverrides): Partial<XmsgEndpoints> {
  const result: Partial<XmsgEndpoints> = {};
  for (const name of names) {
    const value = overrides[name] !== undefined ? overrides[name] : (overrides.xmsgDir === undefined ? undefined :
      join(socket(overrides.xmsgDir, "xmsgDir"), fileNames[name]));
    if (value !== undefined) result[name] = socket(value, name);
  }
  return result;
}

function legacyEndpoints(env: Record<string, string | undefined>): XmsgEndpoints {
  const directory = join(socket(env.XDG_RUNTIME_DIR, "XDG_RUNTIME_DIR for legacy fallback"), "xmsg");
  return { agentSocket: join(directory, "agent.sock"), registerSocket: join(directory, "register.sock"),
    httpSocket: join(directory, "http.sock") };
}

const probeDoctor: DoctorProbe = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, options, (error, stdout) => resolve({ stdout, error }));
});

export function createXmsgEndpointResolver(options: {
  env?: Record<string, string | undefined>;
  probe?: DoctorProbe;
  log?: (line: string) => void;
} = {}): XmsgEndpointResolver {
  const env = { ...(options.env ?? process.env) };
  const probe = options.probe ?? probeDoctor;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let doctor: Promise<Partial<XmsgEndpoints> | string> | undefined;
  let loggedFallback = false;
  async function discover(): Promise<Partial<XmsgEndpoints> | string> {
    let result: DoctorResult;
    try {
      result = await probe("xmsg", ["doctor", "--json"], {
        env, timeout: 3000, maxBuffer: 64 * 1024, encoding: "utf8", shell: false, killSignal: "SIGKILL",
      });
    } catch { throw new XmsgEndpointError("xmsg: doctor invocation failed"); }
    if (result.error?.code === "ENOENT") return "CLI unavailable";
    if (result.error?.killed || result.error?.signal || result.error?.code === "ETIMEDOUT" ||
        result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new XmsgEndpointError("xmsg: doctor exceeded its execution or output bound");
    }
    let report: unknown;
    try { report = JSON.parse(result.stdout); } catch {
      throw new XmsgEndpointError("xmsg: doctor returned invalid JSON");
    }
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      throw new XmsgEndpointError("xmsg: doctor returned an invalid endpoint report");
    }
    const value = report as Record<string, unknown>;
    if (value.endpoints_usable === false) throw new XmsgEndpointError("xmsg: doctor refused endpoint resolution");
    if (value.endpoints_usable !== true) {
      if (["agent_socket", "register_socket", "leaf_register_socket", "http_socket", "endpoints_usable"]
        .some((key) => key in value)) throw new XmsgEndpointError("xmsg: doctor returned an invalid endpoint report");
      return "doctor has no endpoint information";
    }
    const resultPaths: Partial<XmsgEndpoints> = {};
    const fields = { agentSocket: value.agent_socket,
      registerSocket: value.register_socket ?? value.leaf_register_socket, httpSocket: value.http_socket };
    for (const name of names) if (fields[name] !== undefined && fields[name] !== null) {
      resultPaths[name] = socket(fields[name], `doctor ${name}`);
    }
    return resultPaths;
  }
  return async (overrides = {}) => {
    const result = explicitXmsgEndpoints(overrides);
    for (const name of names) if (result[name] === undefined && env[environmentNames[name]] !== undefined) {
      result[name] = socket(env[environmentNames[name]], environmentNames[name]);
    }
    if (names.some((name) => result[name] === undefined)) {
      const discovered = await (doctor ??= discover());
      if (typeof discovered !== "string") {
        for (const name of names) result[name] ??= discovered[name];
        if (names.some((name) => result[name] === undefined)) {
          throw new XmsgEndpointError("xmsg: doctor omitted a required endpoint");
        }
      } else {
        const legacy = legacyEndpoints(env);
        for (const name of names) result[name] ??= legacy[name];
        if (!loggedFallback) { log(`genie: xmsg legacy socket fallback (${discovered})`); loggedFallback = true; }
      }
    }
    return result as XmsgEndpoints;
  };
}

let processResolver: XmsgEndpointResolver | undefined;
export const resolveXmsgEndpoints: XmsgEndpointResolver = (overrides) =>
  (processResolver ??= createXmsgEndpointResolver())(overrides);
