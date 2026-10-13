// A recording stand-in for `pi --mode rpc`: the same JSONL framing on stdin and stdout, and a
// transcript held in this process's memory. Every stdin record is appended to
// `$PI_RECORD/<pid>.jsonl`. It answers prompt (appended to the transcript; no model), get_messages
// and get_state, and exits when stdin closes, as pi does. Given `--session-dir <d> --session-id <id>`,
// it also loads and appends the transcript at `<d>/<id>.jsonl`, as pi resumes a session by id.
// `{type: "host", title, placeholder}` asks its client an `input` dialog, as an extension's
// ctx.ui.input does in pi's RPC mode, and answers with the client's value.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const record = `${process.env.PI_RECORD}/${process.pid}.jsonl`;
const arg = (flag: string) => process.argv[process.argv.indexOf(flag) + 1];
const session = process.argv.includes("--session-dir") ? `${arg("--session-dir")}/${arg("--session-id")}.jsonl` : undefined;
const messages: { role: string; content: string }[] =
  session && existsSync(session) ? readFileSync(session, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const reply = (r: object) => process.stdout.write(`${JSON.stringify({ type: "response", ...r })}\n`);
const dialogs = new Map<string, (value: unknown) => void>();

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    appendFileSync(record, `${line}\n`);
    const cmd = JSON.parse(line);
    const r = { id: cmd.id, command: cmd.type, success: true };
    if (cmd.type === "extension_ui_response") dialogs.get(cmd.id)?.(cmd.value);
    else if (cmd.type === "host") {
      const id = `ui${dialogs.size}`;
      dialogs.set(id, (value) => reply({ ...r, data: { value } }));
      process.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id, method: "input", title: cmd.title, placeholder: cmd.placeholder })}\n`);
    } else if (cmd.type === "prompt") {
      messages.push({ role: "user", content: cmd.message });
      if (session) appendFileSync(session, `${JSON.stringify(messages.at(-1))}\n`);
      reply({ ...r, data: { disposition: "started" } });
      process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    } else if (cmd.type === "get_messages") reply({ ...r, data: { messages } });
    else if (cmd.type === "get_state") reply({ ...r, data: { pid: process.pid, messageCount: messages.length } });
    else reply({ ...r, success: false, error: `unknown command ${cmd.type}` });
  }
});
process.stdin.on("end", () => process.exit(0));
