// The verdict parser's gating oracle: anything that is not exactly one schemas/verdict.json
// object becomes `reject`. Run with `node --test tests/guard.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { PARSE_FAILURE, parseVerdict } from "../src/guard/verdict.ts";

const fixtures = new URL("../schemas/fixtures/verdict/", import.meta.url);
const read = (arm: string) =>
  readdirSync(new URL(arm, fixtures)).map((f) => ({
    f,
    raw: readFileSync(new URL(`${arm}/${f}`, fixtures), "utf8"),
  }));

const failedClosed = (raw: string) => {
  const v = parseVerdict(raw);
  assert.equal(v.verdict, "reject", raw);
  assert.ok(v.reason.startsWith(PARSE_FAILURE), v.reason);
  assert.equal(v.cleaned_text, "");
};

test("every valid verdict fixture parses to itself", () => {
  const valid = read("valid/");
  assert.ok(valid.length > 0);
  for (const { f, raw } of valid) assert.deepEqual(parseVerdict(raw), JSON.parse(raw), f);
});

test("every invalid verdict fixture fails closed to reject", () => {
  const invalid = read("invalid/");
  assert.ok(invalid.length > 0);
  for (const { raw } of invalid) failedClosed(raw);
});

test("unparseable output fails closed to reject", () => {
  const allow = '{"verdict": "allow", "reason": "ok", "cleaned_text": "hi"}';
  for (const raw of [
    "",
    "allow",
    `\`\`\`json\n${allow}\n\`\`\``,
    `Verdict: ${allow}`,
    `${allow}\n${allow}`,
    allow.slice(0, -1),
  ])
    failedClosed(raw);
});

test("well-formed JSON outside the schema fails closed to reject", () => {
  for (const raw of [
    "null",
    "[]",
    '"allow"',
    "1",
    '{"verdict": "allow"}',
    '{"verdict": "Allow", "reason": "ok", "cleaned_text": "hi"}',
    '{"verdict": "allow", "reason": 1, "cleaned_text": "hi"}',
    '{"verdict": "allow", "reason": "ok", "cleaned_text": null}',
    '{"verdict": "allow", "reason": "ok", "cleaned_text": "hi", "trusted": true}',
  ])
    failedClosed(raw);
});

test("a rewrite keeps the guard's cleaned text", () => {
  const v = parseVerdict(
    ' {"verdict": "rewrite", "reason": "override dropped", "cleaned_text": "How do I use den?"}\n',
  );
  assert.deepEqual(v, {
    verdict: "rewrite",
    reason: "override dropped",
    cleaned_text: "How do I use den?",
  });
});
