// A recording stand-in for `pi --mode rpc`: the same JSONL framing on stdin and stdout, and a
// transcript held in this process's memory only. Every stdin record is appended to
// `$PI_RECORD/<pid>.jsonl`. It answers prompt (appended to the transcript; no model), get_messages
// and get_state, and exits when stdin closes, as pi does.
import { appendFileSync } from "node:fs";

const record = `${process.env.PI_RECORD}/${process.pid}.jsonl`;
const messages: { role: string; content: string }[] = [];
const reply = (r: object) => process.stdout.write(`${JSON.stringify({ type: "response", ...r })}\n`);

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
    if (cmd.type === "prompt") {
      messages.push({ role: "user", content: cmd.message });
      reply({ ...r, data: { disposition: "started" } });
      process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    } else if (cmd.type === "get_messages") reply({ ...r, data: { messages } });
    else if (cmd.type === "get_state") reply({ ...r, data: { pid: process.pid, messageCount: messages.length } });
    else reply({ ...r, success: false, error: `unknown command ${cmd.type}` });
  }
});
process.stdin.on("end", () => process.exit(0));
