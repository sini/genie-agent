// The dispatcher's entrypoint (design §5.8, D1c): registers as `svc:genie-expert` on the tier's
// xmsg, reconciles the journal, and delivers until killed. The journal is what a kill leaves, so
// no signal is handled. Built into the `genie-dispatcher` single executable, which is the path
// xmsg's `--svc-exe` attests.
import process from "node:process";
import { CliHerdr } from "./herdr.ts";
import { Delivery, Dispatcher, SocketXmsg } from "./index.ts";

// Each setting is a flag, or the environment variable beside it.
const settings = {
  stateDir: ["--state-dir", "GENIE_STATE_DIR"],
  session: ["--herdr-session", "GENIE_HERDR_SESSION"],
  basePane: ["--base-pane", "GENIE_BASE_PANE"],
  cwd: ["--cwd", "GENIE_CWD"],
  // The single token config directory D1a's stub hands every thread. D4b's pool replaces it.
  tokenConfigDir: ["--token-config-dir", "GENIE_TOKEN_CONFIG_DIR"],
  model: ["--model", "GENIE_MODEL"],
} as const;

interface Config {
  stateDir: string;
  session: string;
  basePane: string;
  cwd: string;
  tokenConfigDir: string;
  model?: string;
  // `$XDG_RUNTIME_DIR/xmsg`, the tier's xmsg instance.
  xmsgDir: string;
}

class ConfigError extends Error {}

function config(argv: string[], env: Record<string, string | undefined>): Config {
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
    if (k !== "model" && !v) throw new ConfigError(`${flag} (or ${name}) is required`);
    c[k] = v || undefined;
  }
  if (!env.XDG_RUNTIME_DIR) throw new ConfigError("XDG_RUNTIME_DIR is required: the tier's xmsg lives under it");
  return { ...(c as Omit<Config, "xmsgDir">), xmsgDir: `${env.XDG_RUNTIME_DIR}/xmsg` };
}

async function main(c: Config): Promise<void> {
  const x = new SocketXmsg(c.xmsgDir, "genie-expert");
  // Registered first: xmsg refuses a second live registration, so a second dispatcher stops here
  // before it reconciles anything.
  await x.register();
  const d = await Dispatcher.open({
    stateDir: c.stateDir,
    herdr: new CliHerdr({ session: c.session, basePane: c.basePane }),
    xmsg: x,
    pickToken: () => ({ id: c.tokenConfigDir, configDir: c.tokenConfigDir }),
    cwd: c.cwd,
    model: c.model,
  });
  const del = new Delivery(d, x);
  del.start();
  await del.run();
}

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
