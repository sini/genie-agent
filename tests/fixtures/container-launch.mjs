import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const [worker, worktree, credential] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify({ type: "worker_namespace_probe", worktreeAbsent: !existsSync(worktree), credentialAbsent: !existsSync(credential) })}\n`);
const child = spawn(process.execPath, ["--experimental-strip-types", worker], { stdio: "inherit", env: process.env });
child.on("error", () => { process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
