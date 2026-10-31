// The dispatcher's entrypoint (design §5.8, D1c; GI-3): registers as `serviceName` (default
// `genie-expert`) on the tier's xmsg, reconciles the journal, and delivers until killed. The
// journal is what a kill leaves, so no signal is handled. Built into the `genie-dispatcher`
// single executable, which is the path xmsg's `--svc-exe` attests.
import process from "node:process";
import type { Clock } from "./clock.ts";
import { CliHerdr, type Herdr } from "./herdr.ts";
import { Delivery, Dispatcher, SocketXmsg, type DeliveryOptions } from "./index.ts";

// Each setting is a flag, or the environment variable beside it.
const settings = {
  stateDir: ["--state-dir", "GENIE_STATE_DIR"],
  session: ["--herdr-session", "GENIE_HERDR_SESSION"],
  cwd: ["--cwd", "GENIE_CWD"],
  // The single token config directory D1a's stub hands every thread. D4b's pool replaces it.
  tokenConfigDir: ["--token-config-dir", "GENIE_TOKEN_CONFIG_DIR"],
  tokenCredentialFile: ["--token-credential-file", "GENIE_TOKEN_CREDENTIAL_FILE"],
  model: ["--model", "GENIE_MODEL"],
  serviceName: ["--service-name", "GENIE_SERVICE_NAME"],
  claudeBin: ["--claude-bin", "GENIE_CLAUDE_BIN"],
} as const;

const OPTIONAL_SETTINGS = new Set(["tokenCredentialFile", "model", "serviceName", "claudeBin"]);

export interface Config {
  stateDir: string;
  session: string;
  cwd: string;
  tokenConfigDir: string;
  tokenCredentialFile?: string;
  model?: string;
  serviceName: string;
  claudeBin?: string;
  // `$XDG_RUNTIME_DIR/xmsg`, the tier's xmsg instance.
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
  const c: Record<string, string | undefined> = {};
  for (const [k, [flag, name]] of Object.entries(settings)) {
    const v = flags.get(flag) ?? env[name];
    if (!OPTIONAL_SETTINGS.has(k) && !v) throw new ConfigError(`${flag} (or ${name}) is required`);
    c[k] = v || undefined;
  }
  if (!env.XDG_RUNTIME_DIR) throw new ConfigError("XDG_RUNTIME_DIR is required: the tier's xmsg lives under it");
  return {
    ...(c as Omit<Config, "xmsgDir" | "serviceName">),
    serviceName: c.serviceName ?? "genie-expert",
    xmsgDir: `${env.XDG_RUNTIME_DIR}/xmsg`,
  };
}

export interface MainDeps {
  herdr?: Herdr;
  clock?: Clock;
  deliveryOptions?: Omit<DeliveryOptions, "archive" | "clock">;
}

export async function startDispatcher(
  c: Config,
  deps: MainDeps = {},
): Promise<{ x: SocketXmsg; d: Dispatcher; del: Delivery }> {
  const x = new SocketXmsg(c.xmsgDir, c.serviceName);
  // Registered first: xmsg refuses a second live registration, so a second dispatcher stops here
  // before it reconciles anything.
  await x.register();
  const credentialsDir =
    process.env.CREDENTIALS_DIRECTORY ??
    (c.tokenCredentialFile ? c.tokenCredentialFile.replace(/\/[^/]+$/, "") : undefined);
  const d = await Dispatcher.open({
    stateDir: c.stateDir,
    herdr:
      deps.herdr ??
      new CliHerdr({
        session: c.session,
        claude: c.claudeBin,
        cwdDir: c.cwd,
        stateDir: c.stateDir,
        credentialsDir,
        tokenCredentialFile: c.tokenCredentialFile,
      }),
    xmsg: x,
    pickToken: () => ({ id: "tier-token", configDir: c.tokenConfigDir }),
    cwd: c.cwd,
    model: c.model,
    now: deps.clock ? () => deps.clock!.now() : undefined,
  });
  const del = new Delivery(d, x, {
    archive: async () => {},
    clock: deps.clock,
    ...deps.deliveryOptions,
  });
  del.start();
  return { x, d, del };
}

export async function main(c: Config): Promise<void> {
  const { del } = await startDispatcher(c);
  await del.run();
}

const isTestRunner = Boolean(process.env.NODE_TEST_CONTEXT);
if (!isTestRunner) {
  let c: Config;
  try {
    c = config(process.argv.slice(2), process.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`genie-dispatcher: ${e.message}\n`);
    process.exit(2);
  }
  main(c).catch((e) => {
    process.stderr.write(`genie-dispatcher: ${e instanceof Error ? e.stack : e}\n`);
    process.exit(1);
  });
}
