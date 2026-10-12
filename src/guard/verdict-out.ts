// guard-out's verdict (design §5.2 layer 6), parsed from the model's raw reply.
// The parser fails closed: a reply that is not exactly one schemas/verdict-out.json
// object, or that breaks the verdict contract, becomes `block`, so a confused or hijacked
// guard cannot leak anything by malforming its output.

// schemas/verdict-out.json
export interface VerdictOut {
  verdict: "pass" | "block";
  reason: string;
}

export const REASON_MAX = 300;

export const REASON_CLASSES = ["leak", "secret_request", "injection", "other"] as const;
export type ReasonClass = (typeof REASON_CLASSES)[number] | "clean";

export function classifyReason(reason: string): ReasonClass {
  const r = reason.trim().toLowerCase();
  for (const c of REASON_CLASSES) {
    if (r === c || r.startsWith(`${c}:`) || r.startsWith(`${c} `) || r.startsWith(`${c}-`)) return c;
  }
  if (
    r.includes("secret_request") ||
    (r.includes("ask") && (r.includes("pat") || r.includes("token") || r.includes("key") || r.includes("secret") || r.includes("credential") || r.includes("password"))) ||
    ((r.includes("secret") || r.includes("credential") || r.includes("token")) && (r.includes("request") || r.includes("paste")))
  )
    return "secret_request";
  if (r.includes("leak") || r.includes("credential") || r.includes("token") || r.includes("key") || r.includes("private")) return "leak";
  if (r.includes("inject") || r.includes("override") || r.includes("directive")) return "injection";
  if (r === "clean" || r.startsWith("clean") || r === "pass" || r.startsWith("pass:") || r.startsWith("pass ") || r === "ok" || r.startsWith("safe")) return "clean";
  return "other";
}

const verdicts = ["pass", "block"];
const keys = ["verdict", "reason"];

// The schema's violations by `value`, empty when it validates.
export function verdictOutErrors(value: unknown): string[] {
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

// Contract checks beyond basic types.
function contractErrors(v: VerdictOut): string[] {
  const errors: string[] = [];
  if (v.reason.length > REASON_MAX || /[\r\n]/.test(v.reason)) errors.push("reason over one line");
  if (v.reason.trim().length === 0) errors.push("empty reason");
  return errors;
}

// The prefix marks a block the parser made, as opposed to one the guard returned.
export const PARSE_FAILURE = "guard-out output invalid: ";

const block = (why: string): VerdictOut => ({
  verdict: "block",
  reason: PARSE_FAILURE + why,
});

// Some models wrap the one object in a markdown fence. Only that outer pair is removed.
const open = /^```(json)? *$/;
const close = /^``` *$/;
function unwrap(reply: string): string {
  if (typeof reply !== "string") return "";
  const t = reply.trim();
  const lines = t.split("\n");
  return lines.length >= 3 && open.test(lines[0]) && close.test(lines[lines.length - 1])
    ? lines.slice(1, -1).join("\n")
    : t;
}

export function parseVerdictOut(reply: string): VerdictOut {
  if (typeof reply !== "string") return block("unparseable");
  const raw = unwrap(reply);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return block("unparseable");
  }
  const errors = verdictOutErrors(value);
  if (errors.length) return block(errors.join("; "));
  const found = memberKeys(raw);
  if (!found || new Set(found).size !== found.length) return block("duplicate keys");
  const v = value as VerdictOut;
  const broken = contractErrors(v);
  if (broken.length) return block(broken.join("; "));
  return v;
}
