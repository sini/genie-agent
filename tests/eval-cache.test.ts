// The eval-result cache (plan E6, design §6): keyed (repo, rev, attr, flags).
// A second identical request runs 0 evals. Mutant: cache bypassed; mutant: cache every result.
// Run with `node --test tests/eval-cache.test.ts`.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { cachedRunner, cacheKeyFor, isCacheable, withCache } from "../src/eval/cache.ts";
import type { EvalResult, Launch } from "../src/eval/run.ts";
import { ThreadStateStore } from "../src/state/index.ts";

const launch = (rev = "main", attr = "pkg", trusted: "yes" | "no" = "no", extraFlags?: string[]): Launch => {
  const l: Launch = {
    request: { repo: "owner/repo", rev, attr, trusted },
    sender_tier: trusted === "yes" ? "trusted" : "public",
  };
  if (extraFlags) {
    (l as unknown as { flags: string[] }).flags = extraFlags;
  }
  return l;
};

const fakeRunner = (initialResult: EvalResult = { exit: 0, stdout_tail: "42", stderr_tail: "", limit_hit: "none" }) => {
  let evalsRun = 0;
  let currentResult = initialResult;
  const runs: Launch[] = [];
  const run = async (l: Launch) => {
    evalsRun++;
    runs.push(l);
    return currentResult;
  };
  return {
    run,
    runs,
    count: () => evalsRun,
    resetCount: () => {
      evalsRun = 0;
    },
    setResult: (r: EvalResult) => {
      currentResult = r;
    },
  };
};

test("oracle: eval-result cache keyed (repo, rev, attr, flags) runs 0 evals on second identical request", async () => {
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-cache-test-`);
  const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
  const f = fakeRunner();
  const thread = "t-cache-1";

  const runCached = withCache(store, (_, l) => f.run(l));

  // 1. First eval runs the runner
  const l1 = launch("main", "pkg", "no");
  const r1 = await runCached(thread, l1);
  assert.equal(r1.exit, 0);
  assert.equal(r1.stdout_tail, "42");
  assert.equal(f.count(), 1, "first eval must run exactly once");

  // 2. Second identical request runs 0 evals
  f.resetCount();
  const r2 = await runCached(thread, l1);
  assert.deepEqual(r2, r1, "cached result must equal original result");
  assert.equal(f.count(), 0, "second identical request must run 0 evals");

  // 3. Different rev -> cache miss, runs an eval
  f.resetCount();
  const lDifferentRev = launch("feat", "pkg", "no");
  await runCached(thread, lDifferentRev);
  assert.equal(f.count(), 1, "different rev must miss cache and run 1 eval");

  // 4. Different attr -> cache miss, runs an eval
  f.resetCount();
  const lDifferentAttr = launch("main", "other", "no");
  await runCached(thread, lDifferentAttr);
  assert.equal(f.count(), 1, "different attr must miss cache and run 1 eval");

  // 5. Different repo -> cache miss, runs an eval
  f.resetCount();
  const lDifferentRepo: Launch = {
    request: { repo: "other/repo", rev: "main", attr: "pkg", trusted: "no" },
    sender_tier: "public",
  };
  await runCached(thread, lDifferentRepo);
  assert.equal(f.count(), 1, "different repo must miss cache and run 1 eval");

  // 6. Different flags -> cache miss, runs an eval
  f.resetCount();
  const lDifferentFlags = launch("main", "pkg", "no", ["--impure"]);
  await runCached(thread, lDifferentFlags);
  assert.equal(f.count(), 1, "different flags must miss cache and run 1 eval");

  // 7. Same flags again -> cache hit, runs 0 evals
  f.resetCount();
  const rFlagsHit = await runCached(thread, lDifferentFlags);
  assert.deepEqual(rFlagsHit, r1);
  assert.equal(f.count(), 0, "same flags again must hit cache and run 0 evals");

  // 8. Different thread -> isolated cache, runs 1 eval
  f.resetCount();
  await runCached("t-cache-2", l1);
  assert.equal(f.count(), 1, "different thread must have isolated cache and run 1 eval");
});

test("oracle: deterministic eval error (exit non-zero with limit_hit none) is cached", async () => {
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-cache-test-`);
  const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
  const evalErrorResult: EvalResult = {
    exit: 1,
    stdout_tail: "",
    stderr_tail: "error: undefined variable 'foo' at /src/flake.nix:12:3",
    limit_hit: "none",
  };
  const f = fakeRunner(evalErrorResult);
  const thread = "t-eval-error";
  const runCached = withCache(store, (_, l) => f.run(l));

  const l = launch("syntax-err", "pkg", "no");
  const r1 = await runCached(thread, l);
  assert.equal(r1.exit, 1);
  assert.equal(r1.limit_hit, "none");
  assert.equal(f.count(), 1);

  // Second identical request hits cache and runs 0 evals
  f.resetCount();
  const r2 = await runCached(thread, l);
  assert.deepEqual(r2, r1);
  assert.equal(f.count(), 0, "deterministic eval error must be cached, running 0 evals on second request");
});

test("oracle: timeout result is not cached, so the next identical request runs 1 eval", async () => {
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-cache-test-`);
  const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
  const timeoutResult: EvalResult = {
    exit: 124,
    stdout_tail: "",
    stderr_tail: "eval killed by deadline",
    limit_hit: "timeout",
  };
  const f = fakeRunner(timeoutResult);
  const thread = "t-timeout";
  const runCached = withCache(store, (_, l) => f.run(l));

  const l = launch("slow", "pkg", "no");
  const r1 = await runCached(thread, l);
  assert.equal(r1.exit, 124);
  assert.equal(r1.limit_hit, "timeout");
  assert.equal(f.count(), 1);

  // Next identical request must NOT hit cache: runs 1 eval again
  f.resetCount();
  const r2 = await runCached(thread, l);
  assert.equal(r2.exit, 124);
  assert.equal(f.count(), 1, "timeout result is transient and must not be cached; second request must run 1 eval");
});

test("oracle: transient limit hits (oom, egress, unknown) are never cached", async () => {
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-cache-test-`);
  const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
  const thread = "t-limits";

  for (const limit of ["oom", "egress", "unknown"] as const) {
    const f = fakeRunner({
      exit: 137,
      stdout_tail: "",
      stderr_tail: `limit: ${limit}`,
      limit_hit: limit,
    });
    const runCached = withCache(store, (_, l) => f.run(l));
    const l = launch(limit, "pkg", "no");

    await runCached(thread, l);
    assert.equal(f.count(), 1);

    f.resetCount();
    await runCached(thread, l);
    assert.equal(f.count(), 1, `limit_hit ${limit} must never be cached; second request must run 1 eval`);
  }
});

test("oracle: cachedRunner provides standalone single-thread runner with caching", async () => {
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-cache-test-`);
  const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
  const f = fakeRunner();
  const runner = cachedRunner(store, "t1", f.run);

  const l = launch("main", "pkg", "no");
  await runner(l);
  assert.equal(f.count(), 1);

  f.resetCount();
  const cached = await runner(l);
  assert.equal(cached.exit, 0);
  assert.equal(f.count(), 0, "second identical request via cachedRunner runs 0 evals");
});

test("oracle: eval-result cache persists across store restarts", async () => {
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-cache-test-`);
  const stateRoot = `${tmp}/state`;
  const storeRoot = `${tmp}/store`;
  const thread = "t-persist";

  // First life: eval runs and writes to disk cache.json
  const store1 = new ThreadStateStore(stateRoot, storeRoot);
  const f1 = fakeRunner();
  const run1 = withCache(store1, (_, l) => f1.run(l));
  const l = launch("v1", "pkg", "no");
  await run1(thread, l);
  assert.equal(f1.count(), 1);

  // Inspect the written cache.json on disk
  const key = cacheKeyFor(l);
  const cacheFile = `${stateRoot}/${thread}/cache.json`;
  const rawCache = JSON.parse(readFileSync(cacheFile, "utf8"));
  const serializedKey = JSON.stringify([key.repo, key.rev, key.attr, key.flags]);
  assert.ok(serializedKey in rawCache, "cache.json must contain serialized [repo, rev, attr, flags] key");
  assert.equal(rawCache[serializedKey].exit, 0);

  // Second life: restart with fresh store instance over the same stateRoot
  const store2 = new ThreadStateStore(stateRoot, storeRoot);
  const f2 = fakeRunner();
  const run2 = withCache(store2, (_, l) => f2.run(l));
  f2.resetCount();

  const r2 = await run2(thread, l);
  assert.equal(r2.exit, 0);
  assert.equal(f2.count(), 0, "resumed thread with persisted cache.json runs 0 evals on identical request");
});

test("mutant (oracle E6): caching every result makes the timeout cell go RED", async () => {
  const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-eval-cache-test-`);
  const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
  const timeoutResult: EvalResult = {
    exit: 124,
    stdout_tail: "",
    stderr_tail: "eval killed by deadline",
    limit_hit: "timeout",
  };
  const f = fakeRunner(timeoutResult);
  const thread = "t-mutant-all";

  // Mutant implementation: caches every result unconditionally without checking isCacheable / limit_hit
  const runMutant = async (t: string, l: Launch) => {
    const key = cacheKeyFor(l);
    const cached = store.cacheGet(t, key) as EvalResult | undefined;
    if (cached !== undefined) return cached;
    const res = await f.run(l);
    store.cachePut(t, key, res); // mutant caches timeout
    return res;
  };

  const l = launch("slow", "pkg", "no");
  await runMutant(thread, l);
  assert.equal(f.count(), 1);

  f.resetCount();
  await runMutant(thread, l);
  // Under the timeout oracle, second request must run 1 eval. Under the mutant, it ran 0 evals.
  assert.throws(
    () => {
      assert.equal(f.count(), 1, "timeout result is transient and must not be cached; second request must run 1 eval");
    },
    /timeout result is transient and must not be cached/,
    "mutant caching every result must make the timeout cell go RED",
  );
});
