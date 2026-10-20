// guard-in's verdict (design §4 step 1), parsed from the model's raw reply against the envelope
// it reviewed. The parser fails closed: a reply that is not exactly one schemas/verdict.json
// object, or that breaks the verdict's contract with the envelope, becomes `reject`, so a
// confused or hijacked guard can let nothing through by malforming its output.
//
// The supervisor forwards the ENVELOPE's `content.text` on `allow`, never the model's copy, and
// forwards and archives the parsed verdict, never `raw`.

// schemas/verdict.json
export type ModelRejectClass =
  | "directs_model"
  | "seeks_holdings"
  | "coerces_tool"
  | "exfil_channel"
  | "hidden_instruction";

export type RejectClass = ModelRejectClass | "guard_error";

export const MODEL_REJECT_CLASSES: readonly ModelRejectClass[] = [
  "directs_model",
  "seeks_holdings",
  "coerces_tool",
  "exfil_channel",
  "hidden_instruction",
];

export const REJECT_CLASSES: readonly RejectClass[] = [
  ...MODEL_REJECT_CLASSES,
  "guard_error",
];

export interface Verdict {
  verdict: "allow" | "rewrite" | "reject";
  class?: RejectClass;
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
  source: "message" | "eval_stdout" | "recall" | "web";
  history: Line[];
  content: { sender?: string; tier?: Line["tier"]; text: string };
}

// A reason is one short line. A rewrite holds the question plus the history context it restates,
// so it is bounded by the envelope's text plus this slack.
export const REASON_MAX = 300;
export const CLEANED_SLACK = 200;

const verdicts = ["allow", "rewrite", "reject"];
const requiredKeys = ["verdict", "reason", "cleaned_text"];
const allowedKeys = ["verdict", "class", "reason", "cleaned_text"];

export function isModelRejectClass(c: unknown): c is ModelRejectClass {
  return typeof c === "string" && (MODEL_REJECT_CLASSES as readonly string[]).includes(c);
}

export function isValidRejectClass(c: unknown): c is RejectClass {
  return typeof c === "string" && (REJECT_CLASSES as readonly string[]).includes(c);
}

// The schema's violations by `value`, empty when it validates.
// Note: `parseVerdict` handles a `reject` lacking a valid `class` separately by logging and
// coercing to `allow` (GI-12(b)); `verdictErrors` validates the post-coercion Verdict shape too.
export function verdictErrors(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["not an object"];
  const v = value as Record<string, unknown>;
  const errors = Object.keys(v)
    .filter((k) => !allowedKeys.includes(k))
    .map((k) => `unknown key ${k}`);
  for (const k of requiredKeys) {
    if (!(k in v)) errors.push(`missing ${k}`);
    else if (typeof v[k] !== "string") errors.push(`${k} is not a string`);
  }
  if ("class" in v && v.class !== undefined && typeof v.class !== "string")
    errors.push("class is not a string");
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
  if (v.reason.length > REASON_MAX || /[\r\n]/.test(v.reason)) errors.push("reason over one line");
  if (v.verdict === "rewrite") {
    const bound =
      reviewed.content.text.length +
      reviewed.history.reduce((n, l) => n + l.text.length, 0) +
      CLEANED_SLACK;
    if (v.cleaned_text.length > bound) errors.push("cleaned_text longer than the envelope");
  }
  return errors;
}

// The prefix marks a reject the parser made, as opposed to one the guard returned.
export const PARSE_FAILURE = "guard-in output invalid: ";

const reject = (why: string): Verdict => ({
  verdict: "reject",
  class: "guard_error",
  reason: PARSE_FAILURE + why,
  cleaned_text: "",
});

// Some models wrap the one object in a markdown fence. Only that outer pair is removed; fences
// inside a cleaned_text string are the user's code and stay.
const open = /^```(json)? *$/;
const close = /^``` *$/;
function unwrap(reply: string): string {
  const t = reply.trim();
  const lines = t.split("\n");
  return lines.length >= 3 && open.test(lines[0]) && close.test(lines[lines.length - 1])
    ? lines.slice(1, -1).join("\n")
    : t;
}

export function parseVerdict(
  reply: string,
  reviewed: Envelope,
  log?: (line: string) => void,
): Verdict {
  const raw = unwrap(reply);
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
  // GI-12(b): a model reject must carry a valid `class` in MODEL_REJECT_CLASSES; a reject without
  // one (including a model writing the reserved `guard_error` class) is logged and treated as `allow`.
  if (v.verdict === "reject") {
    if (!isModelRejectClass(v.class)) {
      const l = log ?? ((line: string) => console.error(line));
      l(
        `genie-guard: reject without valid class (${JSON.stringify(v.class)}) treated as allow: ${v.reason}`,
      );
      return { verdict: "allow", reason: v.reason, cleaned_text: "" };
    }
    return { verdict: "reject", class: v.class, reason: v.reason, cleaned_text: "" };
  }
  // Only a rewrite carries cleaned_text; allow and reject ignore whatever text the guard left.
  if (v.verdict === "rewrite") {
    return { verdict: "rewrite", reason: v.reason, cleaned_text: v.cleaned_text };
  }
  return { verdict: "allow", reason: v.reason, cleaned_text: "" };
}
