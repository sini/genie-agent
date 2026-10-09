// guard-in's verdict (design §4 step 1), parsed from the model's raw reply against the envelope
// it reviewed. The parser fails closed: a reply that is not exactly one schemas/verdict.json
// object, or that breaks the verdict's contract with the envelope, becomes `reject`, so a
// confused or hijacked guard can let nothing through by malforming its output.
//
// The supervisor forwards the ENVELOPE's `content.text` on `allow`, never the model's copy, and
// forwards and archives the parsed verdict, never `raw`.

// schemas/verdict.json
export interface Verdict {
  verdict: "allow" | "rewrite" | "reject";
  reason: string;
  cleaned_text: string;
}

export interface Line {
  sender: string;
  tier: "trusted" | "public";
  text: string;
}

// guard-in's input, the user turn of prompts/guard-in.md. Tiers are the bot's, never the text's.
export interface Envelope {
  source: "message" | "eval_stdout" | "recall";
  history: Line[];
  content: { sender?: string; tier?: Line["tier"]; text: string };
}

// A reason is one short line. A rewrite holds the question plus the history context it restates,
// so it is bounded by the envelope's text plus this slack.
export const REASON_MAX = 300;
export const CLEANED_SLACK = 200;

const verdicts = ["allow", "rewrite", "reject"];
const keys = ["verdict", "reason", "cleaned_text"];

// The schema's violations by `value`, empty when it validates.
export function verdictErrors(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["not an object"];
  const v = value as Record<string, unknown>;
  const errors = Object.keys(v)
    .filter((k) => !keys.includes(k))
    .map((k) => `unknown key ${k}`);
  for (const k of keys) {
    if (!(k in v)) errors.push(`missing ${k}`);
    else if (typeof v[k] !== "string") errors.push(`${k} is not a string`);
  }
  if (typeof v.verdict === "string" && !verdicts.includes(v.verdict))
    errors.push(`verdict ${JSON.stringify(v.verdict)} not in ${verdicts.join("|")}`);
  return errors;
}

// The top-level keys of a flat object of string members, in order, or null when `raw` is not
// one. JSON.parse keeps the last of duplicate keys, and a second reader may keep the first.
const member = /\s*("(?:[^"\\]|\\.)*")\s*:\s*"(?:[^"\\]|\\.)*"\s*([,}])/y;
function memberKeys(raw: string): string[] | null {
  const t = raw.trim();
  if (!t.startsWith("{")) return null;
  member.lastIndex = 1;
  const found: string[] = [];
  for (;;) {
    const m = member.exec(t);
    if (!m) return null;
    found.push(JSON.parse(m[1]));
    if (m[2] === "}") return member.lastIndex === t.length ? found : null;
  }
}

// The verdict's contract with the envelope it reviewed, beyond the schema.
function contractErrors(v: Verdict, reviewed: Envelope): string[] {
  const errors: string[] = [];
  if (v.verdict === "allow" && v.cleaned_text !== reviewed.content.text)
    errors.push("allow with cleaned_text other than the reviewed text");
  if (v.reason.length > REASON_MAX || /[\r\n]/.test(v.reason)) errors.push("reason over one line");
  const bound =
    reviewed.content.text.length +
    reviewed.history.reduce((n, l) => n + l.text.length, 0) +
    CLEANED_SLACK;
  if (v.cleaned_text.length > bound) errors.push("cleaned_text longer than the envelope");
  return errors;
}

// The prefix marks a reject the parser made, as opposed to one the guard returned.
export const PARSE_FAILURE = "guard-in output invalid: ";

const reject = (why: string): Verdict => ({
  verdict: "reject",
  reason: PARSE_FAILURE + why,
  cleaned_text: "",
});

export function parseVerdict(raw: string, reviewed: Envelope): Verdict {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return reject("unparseable");
  }
  const errors = verdictErrors(value);
  if (errors.length) return reject(errors.join("; "));
  const found = memberKeys(raw);
  if (!found || new Set(found).size !== found.length) return reject("duplicate keys");
  const v = value as Verdict;
  const broken = contractErrors(v, reviewed);
  if (broken.length) return reject(broken.join("; "));
  // A reject forwards nothing, whatever text the guard left in it.
  return v.verdict === "reject" ? { ...v, cleaned_text: "" } : v;
}
