// The scorer matches claims as lowercase substrings, so a short or common claim matches almost any answer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { QuestionFixture } from "../src/tier1/eval.ts";

const STOPWORDS = new Set(
  "the use set and for not yes with this that from true false null config option options value host user bug data function module modules merge include includes policy policies class docs date scope cannot private public password maintainer argument system tag order key let pure configuration boot nixpkgs thread evaluation".split(
    " ",
  ),
);

export function weakClaims(q: QuestionFixture): string[] {
  return (q.expected_claims ?? []).filter((c) => c.trim().length < 4 || STOPWORDS.has(c.trim().toLowerCase()));
}

const v2: QuestionFixture[] = readFileSync(new URL("fixtures/tier1-eval/questions-v2.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const memoryQuestions: QuestionFixture[] = readFileSync(
  new URL("fixtures/memory-eval/questions.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

test("questions-v2: ids unique and every claim specific", () => {
  assert.equal(new Set(v2.map((q) => q.id)).size, v2.length);
  const weak = v2.flatMap((q) => weakClaims(q).map((c) => `${q.id}: ${JSON.stringify(c)}`));
  assert.deepEqual(weak, []);
});

test("memory-eval questions: ids unique and every claim specific", () => {
  assert.equal(new Set(memoryQuestions.map((q) => q.id)).size, memoryQuestions.length);
  // While PR #4 (operating-memory-rulings) is pending merge, q22 still references traps/tracker-br-traps.md;
  // once PR #4 merges, q22 is checked like every other question.
  const checked = memoryQuestions.filter(
    (q) => !(q.id === "q22" && q.expected_citations?.includes("traps/tracker-br-traps.md")),
  );
  const weak = checked.flatMap((q) => weakClaims(q).map((c) => `${q.id}: ${JSON.stringify(c)}`));
  assert.deepEqual(weak, []);
});

test("weakClaims refuses a planted short or stopword claim and keeps a specific one", () => {
  const planted: QuestionFixture = { id: "p", question: "q", expected_claims: ["1", "no", "The", "lib.mkIf"] };
  assert.deepEqual(weakClaims(planted), ["1", "no", "The"]);
  assert.deepEqual(weakClaims({ id: "g", question: "q", expected_claims: ["lib.mkIf", "= 1;"] }), []);
});
