// An OpenAI-compatible chat endpoint that stands in for the model: a user message
// `{"tool": name, "args": {...}}` is answered with that one tool call, and a tool result with the
// text "done". Every request body is kept, so a test can read the system prompt pi sent.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function stubModel(): Promise<{ url: string; requests: any[]; close(): void }> {
  const requests: any[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = JSON.parse(body);
      requests.push(r);
      const last = r.messages.at(-1);
      const call = last.role === "user" ? JSON.parse(typeof last.content === "string" ? last.content : last.content[0].text) : undefined;
      const delta = call
        ? { role: "assistant", tool_calls: [{ index: 0, id: `call${n++}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args) } }] }
        : { role: "assistant", content: "done" };
      const chunk = (d: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`${chunk(delta, null)}${chunk({}, call ? "tool_calls" : "stop")}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => server.close() };
}
