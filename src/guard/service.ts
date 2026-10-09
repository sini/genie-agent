// guard-in on ninfer, as one request and its verdict: the S3 harness (tests/guard-eval.ts) and the
// `genie-guard` service both call `review`, so a fix to the request or the parser reaches both.
// The service (genie-solicit-design.md, G1) answers each xmsg message holding an Envelope with
// the parsed verdict, or with `{"error": …}` when it could not review the message at all: an
// error is never a verdict, so a caller holds the line and retries rather than reading it as one.
import type { Inbound, XmsgClient } from "../dispatcher/xmsg.ts";
import { type Envelope, parseVerdict, type Verdict } from "./verdict.ts";

export interface Ninfer {
  // ninfer's OpenAI-compatible base, ending in `/v1`.
  base: string;
  model: string;
  // prompts/guard-in.md.
  system: string;
  timeoutMs?: number;
}

// No review happened: ninfer was unreachable or timed out (`dropped`), or answered with an HTTP
// error or with no message content.
export class Unavailable extends Error {
  readonly dropped: boolean;
  constructor(message: string, dropped = false) {
    super(message);
    this.dropped = dropped;
  }
}

// ninfer's first model, as `/v1/models` lists it.
export async function firstModel(base: string): Promise<string> {
  const res = await fetch(`${base}/models`).catch((e) => {
    throw new Unavailable(`${base}: ${e}`, true);
  });
  if (!res.ok) throw new Unavailable(`${base}/models: HTTP ${res.status}`);
  const id = (await res.json()).data?.[0]?.id;
  if (typeof id !== "string") throw new Unavailable(`no model in ${base}/models`);
  return id;
}

// One guard-in review of `e`. A malformed model reply is a verdict, `reject`, by parseVerdict.
export async function review(e: Envelope, n: Ninfer): Promise<{ raw: string; verdict: Verdict }> {
  const res = await fetch(`${n.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: n.model,
      temperature: 0,
      // A guard that reasons without end is cut off, and its empty reply parses to a reject.
      max_tokens: 8192,
      messages: [
        { role: "system", content: n.system },
        { role: "user", content: JSON.stringify(e) },
      ],
    }),
    signal: n.timeoutMs === undefined ? undefined : AbortSignal.timeout(n.timeoutMs),
  }).catch((err) => {
    throw new Unavailable(String(err), true);
  });
  const body = await res.text().catch((err) => {
    throw new Unavailable(String(err), true);
  });
  if (!res.ok) throw new Unavailable(`HTTP ${res.status} ${body}`);
  let raw: unknown;
  try {
    raw = JSON.parse(body).choices?.[0]?.message?.content;
  } catch {}
  if (typeof raw !== "string") throw new Unavailable("no message content in the reply");
  return { raw, verdict: parseVerdict(raw, e) };
}

// Why `value` is not an Envelope, empty when it is one. Nothing beyond the envelope reaches the
// model, and only `message` content carries a sender and a tier (prompts/guard-in.md).
export function envelopeErrors(value: unknown): string[] {
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const only = (v: Record<string, unknown>, at: string, keys: string[]) =>
    Object.keys(v)
      .filter((k) => !keys.includes(k))
      .map((k) => `unknown key ${at}${k}`);
  const line = (v: unknown, at: string, sender: boolean): string[] => {
    if (!obj(v)) return [`${at} is not an object`];
    const errors = only(v, `${at}.`, sender ? ["sender", "tier", "text"] : ["text"]);
    if (typeof v.text !== "string") errors.push(`${at}.text is not a string`);
    if (sender && typeof v.sender !== "string") errors.push(`${at}.sender is not a string`);
    if (sender && v.tier !== "trusted" && v.tier !== "public") errors.push(`${at}.tier not in trusted|public`);
    return errors;
  };
  if (!obj(value)) return ["not an object"];
  const errors = only(value, "", ["source", "history", "content"]);
  if (!["message", "eval_stdout", "recall"].includes(value.source as string))
    errors.push("source not in message|eval_stdout|recall");
  if (!Array.isArray(value.history)) errors.push("history is not an array");
  else value.history.forEach((l, i) => errors.push(...line(l, `history[${i}]`, true)));
  errors.push(...line(value.content, "content", value.source === "message"));
  return errors;
}

// The reply to one message's text: the verdict, or `{"error": …}` when there is none.
export async function handle(text: string, n: Ninfer): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return JSON.stringify({ error: "not an envelope: unparseable" });
  }
  const errors = envelopeErrors(value);
  if (errors.length) return JSON.stringify({ error: `not an envelope: ${errors.join("; ")}` });
  try {
    const { verdict, reason, cleaned_text } = (await review(value as Envelope, n)).verdict;
    return JSON.stringify({ verdict, reason, cleaned_text });
  } catch (e) {
    if (!(e instanceof Unavailable)) throw e;
    return JSON.stringify({ error: `guard-in unavailable: ${e.message}` });
  }
}

// Answers the next message, if one arrives within waitMs, and acknowledges it once answered: a
// message whose reply was not sent is delivered again.
export async function step(
  x: Pick<XmsgClient, "poll" | "reply" | "ack">,
  n: Ninfer,
  waitMs: number,
): Promise<Inbound | null> {
  const m = await x.poll(waitMs);
  if (!m) return null;
  await x.reply(m.id, await handle(m.text, n));
  await x.ack(m.id);
  return m;
}
