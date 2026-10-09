// guard-in's verdict (design §4 step 1), parsed from the model's raw reply. The parser fails
// closed: a reply that is not exactly one schemas/verdict.json object becomes `reject`, so a
// confused or hijacked guard can never let text through by malforming its output.

// schemas/verdict.json
export interface Verdict {
  verdict: "allow" | "rewrite" | "reject";
  reason: string;
  cleaned_text: string;
}

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

export function parseVerdict(raw: string): Verdict {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return reject("unparseable");
  }
  const errors = verdictErrors(value);
  return errors.length ? reject(errors.join("; ")) : (value as Verdict);
}

// The prefix marks a reject the parser made, as opposed to one the guard returned.
export const PARSE_FAILURE = "guard-in output invalid: ";

const reject = (why: string): Verdict => ({
  verdict: "reject",
  reason: PARSE_FAILURE + why,
  cleaned_text: "",
});
