// herdr does the lifecycle only (design §5.8): start a claude session in a new pane, close a pane,
// list the live agents. Messages never travel through it.
import { execFile } from "node:child_process";

export interface StartSpec {
  name: string;
  // CLAUDE_CONFIG_DIR of the thread's token (row 17).
  configDir: string;
  cwd: string;
  // claude's own arguments, after `--`.
  args: string[];
}

export interface HerdrAgent {
  pane: string;
  name?: string;
}

export interface Herdr {
  // Resolves to the new pane's id once claude is ready for input.
  start(spec: StartSpec): Promise<string>;
  close(pane: string): Promise<void>;
  list(): Promise<HerdrAgent[]>;
}

export type Run = (argv: string[], env: Record<string, string | undefined>) => Promise<string>;

const execRun: Run = (argv, env) =>
  new Promise((resolve, reject) =>
    execFile(argv[0], argv.slice(1), { env }, (err, stdout, stderr) =>
      // herdr prints its error object on stdout and exits 1.
      err ? reject(new Error(`${argv.join(" ")}: ${stdout}${stderr}`)) : resolve(stdout),
    ),
  );

// Unset so a command reaches the session it names and no other (Q2).
const scrubbed = ["HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];

export interface CliOptions {
  session: string;
  // The pane every thread pane is split from: the server's first, never closed.
  basePane: string;
  readyTimeoutMs?: number;
  herdr?: string;
  run?: Run;
}

export class CliHerdr implements Herdr {
  private readonly o: CliOptions;
  private readonly env: Record<string, string | undefined>;

  constructor(o: CliOptions) {
    this.o = o;
    this.env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !scrubbed.includes(k)),
    );
  }

  private async json(args: string[]): Promise<any> {
    const run = this.o.run ?? execRun;
    return JSON.parse(await run([this.o.herdr ?? "herdr", "--session", this.o.session, ...args], this.env));
  }

  async start(s: StartSpec): Promise<string> {
    // The config directory is not a secret, so it rides --env; the token never does (D5's shim).
    const split = await this.json([
      "pane", "split", this.o.basePane, "--direction", "right", "--cwd", s.cwd,
      "--env", `CLAUDE_CONFIG_DIR=${s.configDir}`, "--no-focus",
    ]);
    const pane: string = split.result.pane.pane_id;
    try {
      await this.json([
        "agent", "start", s.name, "--kind", "claude", "--pane", pane,
        "--timeout", String(this.o.readyTimeoutMs ?? 60000), "--", ...s.args,
      ]);
    } catch (e) {
      await this.close(pane);
      throw e;
    }
    return pane;
  }

  // A pane that is already gone is closed; any other refusal throws.
  async close(pane: string): Promise<void> {
    try {
      await this.json(["pane", "close", pane]);
    } catch (e) {
      if (!String(e).includes('"code":"pane_not_found"')) throw e;
    }
  }

  async list(): Promise<HerdrAgent[]> {
    const r = await this.json(["agent", "list"]);
    return r.result.agents.map((a: { pane_id: string; name?: string }) => ({ pane: a.pane_id, name: a.name }));
  }
}
