// genie-guard's settings: each a flag, or the environment variable beside it.
import { readFileSync } from "node:fs";

// Each setting is a flag, or the environment variable beside it.
const settings = {
  base: ["--ninfer-url", "GENIE_GUARD_NINFER_URL"],
  model: ["--model", "GENIE_GUARD_MODEL"],
  timeoutMs: ["--timeout-ms", "GENIE_GUARD_TIMEOUT_MS"],
  apiKeyFile: ["--api-key-file", "GENIE_GUARD_API_KEY_FILE"],
} as const;

export interface Config {
  base: string;
  // Absent: ninfer's first model, read once at start.
  model?: string;
  timeoutMs: number;
  // The bearer key read from --api-key-file; absent: no Authorization header.
  apiKey?: string;
  // `$XDG_RUNTIME_DIR/xmsg`, the owner's xmsg instance.
  xmsgDir: string;
}

export class ConfigError extends Error {}

export function config(argv: string[], env: Record<string, string | undefined>): Config {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!Object.values(settings).some(([f]) => f === flag)) throw new ConfigError(`unknown argument ${flag}`);
    if (value === undefined || value === "") throw new ConfigError(`${flag} needs a value`);
    flags.set(flag, value);
  }
  const get = ([flag, name]: readonly [string, string]) => flags.get(flag) ?? (env[name] || undefined);
  const base = get(settings.base);
  if (!base) throw new ConfigError(`${settings.base[0]} (or ${settings.base[1]}) is required`);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConfigError(`${settings.base[0]}: not a URL: ${base}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError(`${settings.base[0]}: not http(s): ${base}`);
  const timeout = get(settings.timeoutMs) ?? "120000";
  if (!/^[1-9][0-9]*$/.test(timeout)) throw new ConfigError(`${settings.timeoutMs[0]}: not a positive integer: ${timeout}`);
  if (!env.XDG_RUNTIME_DIR) throw new ConfigError("XDG_RUNTIME_DIR is required: the owner's xmsg lives under it");
  let apiKey: string | undefined;
  const keyFile = get(settings.apiKeyFile);
  if (keyFile !== undefined) {
    try {
      apiKey = readFileSync(keyFile, "utf8").trim();
    } catch (e) {
      throw new ConfigError(`${settings.apiKeyFile[0]}: ${e instanceof Error ? e.message : e}`);
    }
    if (!apiKey) throw new ConfigError(`${settings.apiKeyFile[0]}: ${keyFile} is empty`);
  }
  return {
    base: base.replace(/\/+$/, ""),
    model: get(settings.model),
    timeoutMs: Number(timeout),
    apiKey,
    xmsgDir: `${env.XDG_RUNTIME_DIR}/xmsg`,
  };
}
