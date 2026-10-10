// The eval runner's gating oracle, against the local fixture flakes under tests/fixtures/eval/.
// Run with `node --test tests/eval.test.ts`; needs nix and bwrap on PATH.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { effectiveTier, runEval, type Tier } from "../src/eval/run.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/eval/${name}`, import.meta.url));
const run = (name: string, attr: string, trusted: "yes" | "no", sender_tier: Tier) =>
  runEval({ request: { repo: "local/fixture", rev: name, attr, trusted }, sender_tier }, {
    localFlake: fixture(name),
    timeoutMs: 60_000,
  });

test("a plain flake evaluates", async () => {
  const r = await run("plain", "hello", "no", "public");
  assert.equal(r.exit, 0, r.stderr_tail);
  assert.equal(r.stdout_tail.trim(), '"hi"');
  assert.equal(r.limit_hit, "none");
});

test("IFD is refused under public", async () => {
  const r = await run("ifd", "ifd", "no", "public");
  assert.notEqual(r.exit, 0);
  assert.match(r.stderr_tail, /allow-import-from-derivation/);
});

test("IFD is admitted under trusted", async () => {
  const r = await run("ifd", "ifd", "yes", "trusted");
  assert.equal(r.exit, 0, r.stderr_tail);
  assert.equal(r.stdout_tail.trim(), '[ "manifest.nix" ]');
});

test("request.trusted cannot raise a public tier", async () => {
  const r = await run("ifd", "ifd", "yes", "public");
  assert.notEqual(r.exit, 0);
  assert.match(r.stderr_tail, /allow-import-from-derivation/);
});

test("request.trusted=no lowers a trusted tier", async () => {
  const r = await run("ifd", "ifd", "no", "trusted");
  assert.notEqual(r.exit, 0);
});

// Each refusal in the wording of Nix and of Lix ("pure eval mode", a bare "assertion failed").
for (const [attr, refusal] of [
  ["env", /assertion\b.*failed/],
  ["file", /forbidden in pure eval(uation)? mode/],
] as const) {
  test(`impure ${attr} fails under pure-eval, trusted or not`, async () => {
    for (const [trusted, tier] of [
      ["no", "public"],
      ["yes", "trusted"],
    ] as const) {
      const r = await run("impure", attr, trusted, tier);
      assert.notEqual(r.exit, 0, `${tier}: ${r.stdout_tail}`);
      assert.match(r.stderr_tail, refusal);
    }
  });
}

test("a non-github coordinate is refused before nix runs", async () => {
  await assert.rejects(
    runEval({ request: { repo: "a/b/c", rev: "main", attr: "x", trusted: "no" }, sender_tier: "public" }),
    /not a github coordinate/,
  );
});

test("the clamp: trusted only on request yes and a trusted sender tier", () => {
  const request = { repo: "a/b", rev: "main", attr: "x", trusted: "yes" } as const;
  assert.equal(effectiveTier({ request, sender_tier: "trusted" }), "trusted");
  assert.equal(effectiveTier({ request, sender_tier: "public" }), "public");
  assert.equal(effectiveTier({ request: { ...request, trusted: "no" }, sender_tier: "trusted" }), "public");
});
