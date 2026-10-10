// genie-guard's entrypoint (genie-solicit-design.md, G1): registers as `svc:genie-guard` on the
// owner's xmsg and answers each envelope with guard-in's verdict until killed. Built into the
// `genie-guard` single executable with prompts/guard-in.md bundled in, so the attested path
// reviews with the prompt it was built with.
import process from "node:process";
import { SocketXmsg } from "../dispatcher/xmsg.ts";
import system from "../../prompts/guard-in.md";
import { type Config, config, ConfigError } from "./config.ts";
import { start, step, Unauthorized } from "./service.ts";

async function main(c: Config): Promise<void> {
  const x = new SocketXmsg(c.xmsgDir, "genie-guard");
  const n = await start(c, x, system);
  for (;;) await step(x, n, 30_000);
}

let c: Config;
try {
  c = config(process.argv.slice(2), process.env);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  process.stderr.write(`genie-guard: ${e.message}\n`);
  process.exit(2);
}
main(c).catch((e) => {
  if (e instanceof Unauthorized) {
    process.stderr.write(`genie-guard: ${e.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`genie-guard: ${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
