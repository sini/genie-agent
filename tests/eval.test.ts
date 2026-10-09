// The eval runner's gating oracle, against the local fixture flakes under tests/fixtures/eval/.
// Run with `node --test tests/eval.test.ts`; needs nix and bwrap on PATH.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runEval, type Tier } from "../src/eval/run.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/eval/${name}`, import.meta.url));
const run = (name: string, attr: string, trusted: boolean, tier: Tier) =>
  runEval({ repo: "local/fixture", rev: name, attr, trusted }, tier, {
    localFlake: fixture(name),
    timeoutMs: 60_000,
  });

test("a plain flake evaluates", async () => {
  const r = await run("plain", "hello", false, "public");
  assert.equal(r.exit, 0, r.stderr_tail);
  assert.equal(r.stdout_tail.trim(), '"hi"');
  assert.equal(r.limit_hit, "none");
});

test("IFD is refused under public", async () => {
  const r = await run("ifd", "ifd", false, "public");
  assert.notEqual(r.exit, 0);
  assert.match(r.stderr_tail, /allow-import-from-derivation/);
});

test("IFD is admitted under trusted", async () => {
  const r = await run("ifd", "ifd", true, "trusted");
  assert.equal(r.exit, 0, r.stderr_tail);
  assert.equal(r.stdout_tail.trim(), '[ "manifest.nix" ]');
});

test("request.trusted cannot raise a public tier", async () => {
  const r = await run("ifd", "ifd", true, "public");
  assert.notEqual(r.exit, 0);
  assert.match(r.stderr_tail, /allow-import-from-derivation/);
});

test("request.trusted=false lowers a trusted tier", async () => {
  const r = await run("ifd", "ifd", false, "trusted");
  assert.notEqual(r.exit, 0);
});

// Each refusal in the wording of Nix and of Lix ("pure eval mode", a bare "assertion failed").
for (const [attr, refusal] of [
  ["env", /assertion\b.*failed/],
  ["file", /forbidden in pure eval(uation)? mode/],
] as const) {
  test(`impure ${attr} fails under pure-eval, trusted or not`, async () => {
    for (const [trusted, tier] of [
      [false, "public"],
      [true, "trusted"],
    ] as const) {
      const r = await run("impure", attr, trusted, tier);
      assert.notEqual(r.exit, 0, `${tier}: ${r.stdout_tail}`);
      assert.match(r.stderr_tail, refusal);
    }
  });
}

test("a non-github coordinate is refused before nix runs", async () => {
  await assert.rejects(
    runEval({ repo: "a/b/c", rev: "main", attr: "x", trusted: false }, "public"),
    /not a github coordinate/,
  );
});
