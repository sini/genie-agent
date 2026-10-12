// Tier 1's draft parser against fixture replies, and the skills' frontmatter. No model: the live
// scoring of prompts/tier1.md is tests/tier1-eval.ts. Run with `node --test tests/tier1-draft.test.ts`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { draftOf } from "../src/tier1/draft.ts";

const fixtures = new URL("fixtures/tier1-draft/", import.meta.url);
const read = (arm: string, f: string) => JSON.parse(readFileSync(new URL(`${arm}/${f}`, fixtures), "utf8"));

test("oracle: the draft parser accepts every valid reply and rejects every invalid one", () => {
  const valid = readdirSync(new URL("valid/", fixtures));
  const invalid = readdirSync(new URL("invalid/", fixtures));
  assert.ok(valid.length > 0 && invalid.length > 0);
  for (const f of valid) {
    const r = draftOf(read("valid", f));
    assert.ok("draft" in r, `${f}: ${"error" in r ? r.error : ""}`);
    assert.equal(typeof r.draft.confidence, "number", f);
    assert.ok(Array.isArray(r.draft.gaps), f);
    assert.equal(typeof r.draft.escalate_forced, "boolean", f);
  }
  for (const f of invalid) assert.ok("error" in draftOf(read("invalid", f)), `${f} parsed`);
});

test("each skill is a pi skill: SKILL.md with a name equal to its directory and a description", () => {
  const skills = new URL("../skills/", import.meta.url);
  const dirs = readdirSync(skills).sort();
  assert.deepEqual(dirs, ["den", "escalation", "gen", "nix-eval"]);
  for (const d of dirs) {
    const front = readFileSync(new URL(`${d}/SKILL.md`, skills), "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    assert.ok(front, `${d}: no frontmatter`);
    assert.match(front, new RegExp(`^name: ${d}$`, "m"), d);
    const description = front.match(/^description: (.+)$/m)?.[1] ?? "";
    assert.ok(description.length > 0 && description.length <= 1024, `${d}: description`);
  }
});
