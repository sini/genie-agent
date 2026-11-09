import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { killWithChildren } from "../supervisor/index.ts";
import { piAiPath } from "./custody.ts";
import { piToolsPath } from "./files.ts";
import { CONFIG_ENV } from "./extension.ts";
import { writePiModelsJson } from "./launch.ts";
import { CUSTODY_ENV, custodyCall } from "./socket.ts";
import type { WorkerBootstrap } from "./container.ts";

export async function runWorker(input: any, output: any): Promise<number> {
  input.setEncoding?.("utf8");
  let pending = "", bootstrap: WorkerBootstrap | undefined;
  const iterator = input[Symbol.asyncIterator]();
  while (!bootstrap) {
    const next = await iterator.next();
    if (next.done) throw new Error("worker bootstrap missing");
    pending += next.value;
    if (pending.length > 2 * 1024 * 1024) throw new Error("worker bootstrap too large");
    const nl = pending.indexOf("\n");
    if (nl >= 0) { bootstrap = JSON.parse(pending.slice(0, nl)); pending = pending.slice(nl + 1); }
  }
  if (bootstrap.type !== "genie-worker" || !bootstrap.custody?.socket || !bootstrap.config) throw new Error("invalid worker bootstrap");
  const home = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-worker-`);
  const sessionDir = `${home}/session`, session = `${sessionDir}/thread.jsonl`, agent = `${home}/agent`;
  mkdirSync(sessionDir, { mode: 0o700 }); mkdirSync(agent, { mode: 0o700 });
  const socket = bootstrap.custody.socket;
  try {
    let offset = 0;
    for (;;) {
      const r = await custodyCall(socket, { method: "session", op: "read", offset });
      const bytes = Buffer.from(r.data, "base64");
      if (r.next !== offset + bytes.length || r.next > r.total) throw new Error("invalid root session response");
      if (!offset && bytes.length) {
        const nl = bytes.indexOf(10);
        if (nl < 0) throw new Error("invalid root session header");
        const header = JSON.parse(bytes.subarray(0, nl).toString("utf8"));
        if (header.type !== "session") throw new Error("invalid root session header");
        writeFileSync(session, `${JSON.stringify({ ...header, cwd: home })}\n`);
        appendFileSync(session, bytes.subarray(nl + 1));
      } else if (bytes.length) appendFileSync(session, bytes);
      if (r.next === offset && r.next < r.total) throw new Error("empty root session chunk");
      offset = r.next;
      if (offset === r.total) break;
    }
    const pi = bootstrap.pi ?? "pi";
    const repo = bootstrap.repoRoot ?? process.env.GENIE_REPO_ROOT ?? new URL("../../", import.meta.url).pathname;
    const prompt = `${home}/prompt.md`; writeFileSync(prompt, bootstrap.prompt);
    writePiModelsJson(agent, bootstrap.custody.model);
    const custody = { ...bootstrap.custody, sdk: piToolsPath(piAiPath(pi)), remoteFiles: true };
    const child = spawn(pi, ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
      "-e", resolve(repo, "src/tier1/extension.ts"), "--system-prompt", prompt,
      ...bootstrap.appendPrompts.flatMap((p) => ["--append-system-prompt", p]),
      "--model", `genie/${custody.model.id}`, "--api-key", "root-custody-placeholder", "--session-dir", sessionDir, "--session", session], {
      cwd: home, detached: true, stdio: ["pipe", "pipe", "inherit"],
      env: { PATH: process.env.PATH ?? "/bin:/usr/bin", HOME: home, XDG_CONFIG_HOME: `${home}/config`, XDG_CACHE_HOME: `${home}/cache`, XDG_STATE_HOME: `${home}/state`,
        ...Object.fromEntries(["SSL_CERT_FILE", "NIX_SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"].filter(k => process.env[k]).map(k => [k, process.env[k]!])),
        PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", GENIE_REPO_ROOT: repo,
        [CUSTODY_ENV]: JSON.stringify(custody), [CONFIG_ENV]: JSON.stringify(bootstrap.config) },
    });
    const save = async () => {
      if (!existsSync(session)) return;
      const fd = openSync(session, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error("invalid worker session file");
        const upload = await custodyCall(socket, { method: "session", op: "begin" });
        const bytes = new Uint8Array(65536);
        for (let pos = 0; pos < st.size;) {
          const count = readSync(fd, bytes, 0, Math.min(bytes.length, st.size - pos), pos);
          if (!count) throw new Error("worker session ended early");
          await custodyCall(socket, { method: "session", op: "chunk", id: upload.id, offset: pos, data: Buffer.from(bytes.subarray(0, count)).toString("base64") });
          pos += count;
        }
        await custodyCall(socket, { method: "session", op: "commit", id: upload.id, size: st.size });
      } finally { closeSync(fd); }
    };
    const stop = () => killWithChildren(child, "SIGKILL", true);
    let line = "", forwarding = Promise.resolve();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      line += chunk;
      let nl: number;
      while ((nl = line.indexOf("\n")) >= 0) {
        const record = line.slice(0, nl); line = line.slice(nl + 1);
        forwarding = forwarding.then(async () => {
          if (JSON.parse(record).type === "agent_settled") await save();
          output.write(`${record}\n`);
        });
        void forwarding.catch(stop);
      }
    });
    child.stdin.on("error", () => {});
    const io = process as any;
    io.once("SIGTERM", stop); io.once("SIGINT", stop);
    const exited = new Promise<number>((resolveExit, reject) => {
      child.on("error", () => { input.destroy?.(); reject(new Error("worker pi launch failed")); });
      child.on("exit", (code) => { input.destroy?.(); resolveExit(code ?? 1); });
    });
    void (async () => {
      if (pending) child.stdin.write(pending);
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        child.stdin.write(String(next.value));
      }
      child.stdin.end();
    })().catch(stop);
    try {
      const code = await exited;
      await forwarding; await save();
      return code;
    } finally { stop(); io.removeListener("SIGTERM", stop); io.removeListener("SIGINT", stop); }
  } finally { input.destroy?.(); rmSync(home, { recursive: true, force: true }); }
}
