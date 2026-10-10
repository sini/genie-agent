// The C1 tools' parameters, from the repo's schemas/<name>.json. The model sees each schema with
// its $refs inlined and every boolean offered as "yes" | "no" (K4: Qwen writes `False`, and a
// strict tool-call parser then drops the call to text); its arguments are mapped back and
// validated against the repo's schema itself before any effect.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Schema = { [k: string]: any };

// The keywords the repo's schemas use. A schema with any other is refused at load, so a keyword
// this validator would silently ignore never reads as a pass.
const known = new Set([
  "$schema", "title", "description", "type", "required", "properties", "additionalProperties",
  "items", "enum", "const", "minLength", "minimum", "maximum", "minProperties", "$ref", "if", "then",
]);

const dir = new URL("../../schemas/", import.meta.url);

export function load(name: string): Schema {
  const s = JSON.parse(readFileSync(fileURLToPath(new URL(`${name}.json`, dir)), "utf8"));
  const check = (v: unknown): void => {
    if (typeof v !== "object" || v === null) return;
    if (Array.isArray(v)) return v.forEach(check);
    for (const [k, sub] of Object.entries(v)) {
      if (!known.has(k)) throw new Error(`schemas/${name}.json: unsupported keyword ${k}`);
      if (k === "properties") Object.values(sub as object).forEach(check);
      else if (k !== "enum" && k !== "const" && k !== "required") check(sub);
    }
  };
  check(s);
  return s;
}

const deref = (s: Schema): Schema => (s.$ref ? load(s.$ref.replace(/\.json$/, "")) : s);

// Why `value` is not an instance of `s`, empty when it is one.
export function errors(s: Schema, value: unknown, at = "$"): string[] {
  s = deref(s);
  const out: string[] = [];
  const obj = typeof value === "object" && value !== null && !Array.isArray(value);
  const is: Record<string, boolean> = {
    object: obj,
    array: Array.isArray(value),
    string: typeof value === "string",
    number: typeof value === "number" && Number.isFinite(value),
    integer: Number.isInteger(value),
    boolean: typeof value === "boolean",
  };
  if (s.type && !is[s.type]) return [`${at} is not ${s.type}`];
  if (s.enum && !s.enum.includes(value)) out.push(`${at} not in ${s.enum.join("|")}`);
  if ("const" in s && value !== s.const) out.push(`${at} is not ${JSON.stringify(s.const)}`);
  if (typeof value === "string" && value.length < (s.minLength ?? 0)) out.push(`${at} is shorter than ${s.minLength}`);
  if (typeof value === "number" && value < (s.minimum ?? -Infinity)) out.push(`${at} is below ${s.minimum}`);
  if (typeof value === "number" && value > (s.maximum ?? Infinity)) out.push(`${at} is above ${s.maximum}`);
  if (Array.isArray(value) && s.items) value.forEach((v, i) => out.push(...errors(s.items, v, `${at}[${i}]`)));
  if (obj) {
    const v = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in v)) out.push(`${at}.${k} is missing`);
    if (Object.keys(v).length < (s.minProperties ?? 0)) out.push(`${at} has fewer than ${s.minProperties} members`);
    for (const [k, m] of Object.entries(v)) {
      const p = s.properties?.[k] ?? s.additionalProperties;
      if (p === false) out.push(`${at}.${k} is not allowed`);
      else if (p && p !== true) out.push(...errors(p, m, `${at}.${k}`));
    }
  }
  if (s.if && errors(s.if, value, at).length === 0 && s.then) out.push(...errors(s.then, value, at));
  return out;
}

// What the model is offered: refs inlined, booleans as "yes" | "no", and no if/then (some
// providers refuse it in a tool schema; the repo's schema still enforces it).
export function forModel(s: Schema): Schema {
  s = deref(s);
  if (s.type === "boolean") return { ...(s.description ? { description: s.description } : {}), enum: ["yes", "no"] };
  const out: Schema = {};
  for (const [k, v] of Object.entries(s)) {
    if (["$schema", "$ref", "if", "then"].includes(k)) continue;
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, forModel(ps as Schema)]));
    else if ((k === "items" || k === "additionalProperties") && typeof v === "object") out[k] = forModel(v);
    else out[k] = v;
  }
  return out;
}

// The model's arguments as an instance of the repo's schema: "yes"/"no" where it holds a boolean.
// Anything else there becomes a string, which the boolean then refuses.
export function fromModel(s: Schema, value: unknown): unknown {
  s = deref(s);
  if (s.type === "boolean") return value === "yes" ? true : value === "no" ? false : String(value);
  if (Array.isArray(value) && s.items) return value.map((v) => fromModel(s.items, v));
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const p = s.properties?.[k] ?? s.additionalProperties;
        return [k, p && typeof p === "object" ? fromModel(p, v) : v];
      }),
    );
  }
  return value;
}
