// The tier-1 composition root's CLI entrypoint (GI-2, genie-local-deploy-plan-v0.md):
// accepts `--config <path>` (or `GENIE_CONFIG`), registers `XmsgIo` on xmsg as service `genie`
// (or `config.xmsg.service`), starts lifecycle/GC timers, and runs the intake loop until stopped.
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { type Config as RootConfig, main, validateRootConfig } from "./index.ts";
import { XmsgIo } from "./io.ts";

export class ConfigError extends Error {}

export interface CliOptions {
  configPath: string;
  xmsgDir: string;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): CliOptions {
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
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
  const xmsgDir = env.XDG_RUNTIME_DIR ? `${env.XDG_RUNTIME_DIR}/xmsg` : "/run/xmsg";
  return { configPath, xmsgDir };
}

async function run(opts: CliOptions): Promise<void> {
  const raw: RootConfig = JSON.parse(readFileSync(opts.configPath, "utf8"));
  const { guardEnable } = validateRootConfig(raw);
  const io = new XmsgIo({
    xmsgDir: raw.xmsg?.xmsgDir ?? opts.xmsgDir,
    service: raw.xmsg?.service ?? "genie",
    pollWaitMs: raw.xmsg?.pollWaitMs,
    guard: guardEnable ? raw.xmsg?.guard : null,
    guardEnable,
  });
  await io.register();
  const root = main(opts.configPath, io);
  root.start();
  const shutdown = () => {
    io.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await root.run();
  } finally {
    await root.stop();
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

