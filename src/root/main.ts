// The tier-1 composition root's CLI entrypoint (GI-2, genie-local-deploy-plan-v0.md):
// accepts `--config <path>` (or `GENIE_CONFIG`), registers `XmsgIo` on xmsg as service `genie`
// (or `config.xmsg.service`), starts lifecycle/GC timers, and runs the intake loop until stopped.
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { type Config as RootConfig, main, validateRootConfig } from "./index.ts";
import { XmsgIo } from "./io.ts";
import { explicitXmsgEndpoints, xmsgEndpointFlags, type XmsgEndpointOverrides } from "../dispatcher/xmsg.ts";

export class ConfigError extends Error {}

export interface CliOptions extends XmsgEndpointOverrides {
  configPath: string;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): CliOptions {
  let configPath: string | undefined;
  const endpoints: XmsgEndpointOverrides = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(xmsgEndpointFlags, arg)) {
      const value = argv[++i];
      if (value === undefined || value === "") throw new ConfigError(`${arg} needs a value`);
      endpoints[xmsgEndpointFlags[arg as keyof typeof xmsgEndpointFlags]] = value;
    } else if (arg === "--config") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new ConfigError("--config needs a value");
      configPath = value;
    } else if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value === "") throw new ConfigError("--config needs a value");
      configPath = value;
    } else {
      throw new ConfigError(`unknown argument ${arg}`);
    }
  }
  configPath = configPath ?? env.GENIE_CONFIG;
  if (!configPath) throw new ConfigError("--config (or GENIE_CONFIG) is required");
  if (!existsSync(configPath)) throw new ConfigError(`--config: file not found: ${configPath}`);
  return { configPath, ...endpoints };
}

export function rootXmsgEndpoints(config: XmsgEndpointOverrides, cli: XmsgEndpointOverrides) {
  return explicitXmsgEndpoints({ ...(cli.xmsgDir === undefined ? config : {}), ...cli });
}

async function run(opts: CliOptions): Promise<void> {
  const raw: RootConfig = JSON.parse(readFileSync(opts.configPath, "utf8"));
  const { guardEnable } = validateRootConfig(raw);
  const io = new XmsgIo({
    ...rootXmsgEndpoints(raw.xmsg ?? {}, opts),
    service: raw.xmsg?.service ?? "genie",
    pollWaitMs: raw.xmsg?.pollWaitMs,
    guard: guardEnable ? raw.xmsg?.guard : null,
    guardEnable,
  });
  let stopping = false;
  let started = false;
  let ioClosed = false;
  const closeIo = () => {
    if (ioClosed) return;
    ioClosed = true;
    io.close();
  };
  const stopController = new AbortController();
  const shutdown = () => {
    stopping = true;
    if (started) io.closeIntake();
    else closeIo();
    stopController.abort();
  };
  // Before registering, which can wait on xmsg indefinitely: as PID 1 (the unit's PrivatePIDs=)
  // an unhandled TERM is ignored and a stop waits out TimeoutStopSec.
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await io.register(false);
  } catch (e) {
    if (stopping) {
      closeIo();
      return;
    }
    throw e;
  }
  if (stopping) {
    closeIo();
    return;
  }
  const root = main(opts.configPath, io);
  io.resume();
  await root.start();
  started = true;
  try {
    await root.run({ signal: stopController.signal });
  } finally {
    await root.stop();
    closeIo();
  }
}

const isTestRunner = Boolean(process.env.NODE_TEST_CONTEXT);
if (!isTestRunner) {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2), process.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`genie-root: ${e.message}\n`);
    process.exit(2);
  }
  run(opts).catch((e) => {
    process.stderr.write(`genie-root: ${e instanceof Error ? e.stack : e}\n`);
    process.exit(1);
  });
}

