// The seed guard (plan S6, design §4 step 2, §6, oracle 19): every recalled bank entry and every
// replayed transcript passes guard-in before it seeds a session, because bank content and archived
// transcripts carry attacker-derived text re-entering a fresh context.
//
// Each check is a fresh session: an independent request with `history: []`, so no earlier thread
// text rides along. The source is `recall`, guard-in's evidence class for memory notes and past
// transcripts. A reject, unavailable, a throw, or a reply that is not a verdict refuses the seed.
import type { Verdict } from "../guard/verdict.ts";
import { verdictErrors } from "../guard/verdict.ts";
import type { GuardClient, Unavailable } from "./guard-client.ts";
import type { Supervisor } from "./index.ts";

export interface TranscriptMessage {
  role?: string;
  content?: string;
  type?: string;
  message?: string;
  [key: string]: unknown;
}

export interface SeedGuard {
  bankEntry(entry: string | { text: string; [k: string]: unknown }): Promise<string>;
  transcript(transcript: string): Promise<string>;
  transcriptMessages<T extends TranscriptMessage>(messages: T[]): Promise<T[]>;
}

export interface SeedInput {
  bankEntry?: string | { text: string; [k: string]: unknown };
  transcript?: string | TranscriptMessage[];
}

export function seedGuard(
  client: GuardClient | undefined,
  opts: { enabled?: boolean } = {},
): SeedGuard {
  const enabled = opts.enabled ?? true;
  const refused = (why: string) => new Error(`seed refused by the guard: ${why}`);

  const screen = async (text: string): Promise<string> => {
    if (!enabled) return text;
    if (!client) throw refused("unavailable (guard client not configured)");
    let v: Verdict | Unavailable;
    try {
      v = await client.check({ source: "recall", history: [], content: { text } });
    } catch (e) {
      v = { unavailable: e instanceof Error ? e.message : String(e) };
    }
    if (typeof (v as Unavailable)?.unavailable === "string")
      throw refused(`unavailable (${(v as Unavailable).unavailable})`);
    if (verdictErrors(v).length) throw refused("the reply is not a verdict");
    const verdict = v as Verdict;
    if (verdict.verdict === "allow") return text;
    if (verdict.verdict === "rewrite") return verdict.cleaned_text;
    throw refused(verdict.reason);
  };

  return {
    async bankEntry(entry: string | { text: string; [k: string]: unknown }): Promise<string> {
      const text = typeof entry === "string" ? entry : entry?.text;
      if (typeof text !== "string") throw refused("bank entry is not text");
      if (text === "") return "";
      return screen(text);
    },

    async transcript(raw: string): Promise<string> {
      if (typeof raw !== "string") throw refused("transcript is not a string");
      if (!raw.trim()) return raw;
      const lines = raw.split("\n");
      const cleaned: string[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line);
        } catch {
          cleaned.push(await screen(line));
          continue;
        }
        if (typeof obj === "object" && obj !== null) {
          const field = "content" in obj ? "content" : "message" in obj ? "message" : undefined;
          if (field && typeof obj[field] === "string" && obj[field] !== "") {
            const cleanedText = await screen(obj[field] as string);
            cleaned.push(JSON.stringify({ ...obj, [field]: cleanedText }));
          } else {
            cleaned.push(line);
          }
        } else {
          cleaned.push(line);
        }
      }
      return cleaned.join("\n") + "\n";
    },

    async transcriptMessages<T extends TranscriptMessage>(messages: T[]): Promise<T[]> {
      if (!Array.isArray(messages)) throw refused("transcript messages is not an array");
      const out: T[] = [];
      for (const msg of messages) {
        const field = "content" in msg ? "content" : "message" in msg ? "message" : undefined;
        if (field && typeof msg[field] === "string" && msg[field] !== "") {
          const cleanedText = await screen(msg[field] as string);
          out.push({ ...msg, [field]: cleanedText });
        } else {
          out.push(msg);
        }
      }
      return out;
    },
  };
}

// Seed a thread's session in the supervisor with a bank entry and/or transcript.
// If guard is provided, passes each through the seed guard before the session sees it.
export async function seedSession(
  supervisor: Supervisor,
  thread: string,
  seed: SeedInput,
  guard?: SeedGuard,
): Promise<void> {
  if (seed.bankEntry !== undefined) {
    const text = guard
      ? await guard.bankEntry(seed.bankEntry)
      : typeof seed.bankEntry === "string"
        ? seed.bankEntry
        : seed.bankEntry.text;
    await supervisor.command(thread, { type: "prompt", message: text });
  }

  if (seed.transcript !== undefined) {
    if (typeof seed.transcript === "string") {
      const screened = guard ? await guard.transcript(seed.transcript) : seed.transcript;
      const lines = screened.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        let msgText = line;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed === "object" && parsed !== null) {
            msgText = (parsed.content ?? parsed.message ?? line) as string;
          }
        } catch {}
        await supervisor.command(thread, { type: "prompt", message: msgText });
      }
    } else if (Array.isArray(seed.transcript)) {
      const screened = guard
        ? await guard.transcriptMessages(seed.transcript)
        : seed.transcript;
      for (const msg of screened) {
        const text = (msg.content ?? msg.message ?? (typeof msg === "string" ? msg : JSON.stringify(msg))) as string;
        await supervisor.command(thread, { type: "prompt", message: text });
      }
    }
  }
}
