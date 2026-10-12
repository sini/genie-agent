// The verdict-out parser's gating oracle: anything that is not exactly one schemas/verdict-out.json
// object becomes `block`. Run with `node --test tests/guard-out.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  PARSE_FAILURE,
  parseVerdictOut,
  REASON_MAX,
  type VerdictOut,
  classifyReason,
} from "../src/guard/verdict-out.ts";

const json = (verdict: string, reason: string) => JSON.stringify({ verdict, reason });

const fixtures = new URL("../schemas/fixtures/verdict-out/", import.meta.url);
const read = (arm: string) =>
  readdirSync(new URL(arm, fixtures)).map((f) => ({
    f,
    raw: readFileSync(new URL(`${arm}/${f}`, fixtures), "utf8"),
  }));

const failedClosed = (raw: string, why = "") => {
  const v = parseVerdictOut(raw);
  assert.equal(v.verdict, "block", raw);
  assert.ok(v.reason.startsWith(PARSE_FAILURE + why), `${v.reason} does not start with ${PARSE_FAILURE + why}`);
};

test("every valid verdict-out fixture parses to itself", () => {
  const valid = read("valid/");
  assert.ok(valid.length > 0);
  for (const { f, raw } of valid) {
    const v = JSON.parse(raw);
    assert.deepEqual(parseVerdictOut(raw), v, f);
  }
});

test("every invalid verdict-out fixture fails closed to block", () => {
  const invalid = read("invalid/");
  assert.ok(invalid.length > 0);
  for (const { raw } of invalid) failedClosed(raw);
});

test("a missing key is named", () => {
  failedClosed('{"verdict": "pass"}', "missing reason");
  failedClosed('{"reason": "clean"}', "missing verdict");
});

test("unparseable output fails closed to block", () => {
  const pass = json("pass", "clean");
  for (const raw of [
    "",
    "pass",
    `Verdict: ${pass}`,
    `${pass}\n${pass}`,
    pass.slice(0, -1),
  ])
    failedClosed(raw);
});

const fence = "```";
const fenced = (body: string, tag = "json") => `${fence}${tag}\n${body}\n${fence}`;

test("a verdict in one outer code fence parses to its verdict", () => {
  const pass = json("pass", "clean");
  for (const raw of [
    fenced(pass),
    fenced(pass, ""),
    `  ${fenced(pass)}\n\n`,
    `${fence}json  \n${pass}\n${fence}  `,
  ])
    assert.equal(parseVerdictOut(raw).verdict, "pass", raw);

  const block = json("block", "leak");
  assert.deepEqual(parseVerdictOut(fenced(block)), { verdict: "block", reason: "leak" });
});

test("a fence is only unwrapped when it is the whole reply", () => {
  const pass = json("pass", "clean");
  for (const raw of [
    `Here you go:\n${fenced(pass)}`,
    `${fenced(pass)}\nHope that helps.`,
    `${fenced(pass)}\n${fenced(pass)}`,
    `${fence}json\n${pass}`,
    fenced(pass, "python"),
    fenced("not json"),
    fenced(""),
    `${fence}${pass}${fence}`,
  ])
    failedClosed(raw, "unparseable");
});

test("duplicate keys inside a fence fail closed to block", () => {
  const dup = '{"verdict": "pass", "reason": "clean", "verdict": "pass"}';
  failedClosed(fenced(dup), "duplicate keys");
});

test("duplicate keys fail closed to block", () => {
  for (const raw of [
    '{"verdict": "block", "reason": "leak", "verdict": "pass"}',
    '{"verdict": "pass", "reason": "clean", "verdict": "block"}',
  ])
    failedClosed(raw, "duplicate keys");
});

test("well-formed JSON outside the schema fails closed to block", () => {
  for (const raw of [
    "null",
    "[]",
    '"pass"',
    "1",
    '{"verdict": "pass"}',
    json("Pass", "clean"),
    json("allow", "clean"),
    json("reject", "leak"),
    '{"verdict": "pass", "reason": 1}',
    '{"verdict": "pass", "reason": null}',
    '{"verdict": "pass", "reason": "clean", "extra": true}',
  ])
    failedClosed(raw);
});

test("an over-long reason or multiline reason fails closed to block", () => {
  failedClosed(json("block", "x".repeat(REASON_MAX + 1)), "reason over one line");
  failedClosed(json("block", "two\nlines"), "reason over one line");
  failedClosed(json("pass", "   "), "empty reason");
  assert.equal(parseVerdictOut(json("block", "x".repeat(REASON_MAX))).verdict, "block");
});

test("classifyReason extracts reason classes accurately", () => {
  assert.equal(classifyReason("leak"), "leak");
  assert.equal(classifyReason("leak: Matrix token exposed"), "leak");
  assert.equal(classifyReason("secret_request"), "secret_request");
  assert.equal(classifyReason("asks user for GitHub PAT"), "secret_request");
  assert.equal(classifyReason("injection"), "injection");
  assert.equal(classifyReason("override instruction forwarded"), "injection");
  assert.equal(classifyReason("clean"), "clean");
  assert.equal(classifyReason("pass: safe explanation"), "clean");
  assert.equal(classifyReason("other"), "other");
});

test("oracle 2: parser fails closed to block on invalid or malformed output", () => {
  // Prose
  failedClosed("I have reviewed the response and it looks completely safe to send to the user.");
  // Two fences
  failedClosed(`${fenced(json("pass", "clean"))}\n${fenced(json("pass", "clean"))}`);
  // An unclosed fence
  failedClosed(`\`\`\`json\n{"verdict": "pass", "reason": "clean"}`);
  // An unknown verdict
  failedClosed(json("maybe", "unknown"));
  failedClosed(json("allow", "clean"));
  failedClosed(json("reject", "leak"));
});
