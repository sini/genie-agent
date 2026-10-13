// The per-thread eval lock (plan E8, design oracle 15) against a recording fake runner that holds each
// run open until the test releases it, so overlap is read from the runner's own count, never from timing.
// Run with `node --test tests/eval-lock.test.ts`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { perThread } from "../src/eval/lock.ts";
import type { EvalResult, Launch } from "../src/eval/run.ts";

const launch = (rev: string): Launch => ({
  request: { repo: "o/r", rev, attr: "x", trusted: "no" },
  sender_tier: "public",
});
const ok: EvalResult = { exit: 0, stdout_tail: "", stderr_tail: "", limit_hit: "none" };
const timedOut: EvalResult = { exit: 124, stdout_tail: "", stderr_tail: "", limit_hit: "timeout" };

const fake = () => {
  const started: string[] = [];
  const pending: ((r: EvalResult | Error) => void)[] = [];
  let live = 0;
  let peak = 0;
  const run = (l: Launch) =>
    new Promise<EvalResult>((resolve, reject) => {
      started.push(l.request.rev);
      peak = Math.max(peak, ++live);
      pending.push((r) => {
        live--;
        r instanceof Error ? reject(r) : resolve(r);
      });
    });
  // Release the oldest open run.
  const release = (r: EvalResult | Error = ok) => pending.shift()!(r);
  return { run, started, release, peak: () => peak };
};
const settle = () => new Promise((r) => setImmediate(r));

test("oracle 15: two requests on one thread never overlap, and run in arrival order", { timeout: 5_000 }, async () => {
  const f = fake();
  const launchOn = perThread(f.run);
  const runs = ["a", "b", "c"].map((rev) => launchOn("T", launch(rev)));
  await settle();
  assert.deepEqual(f.started, ["a"]);
  f.release();
  await settle();
  assert.deepEqual(f.started, ["a", "b"]);
  f.release();
  await settle();
  f.release();
  await Promise.all(runs);
  assert.deepEqual(f.started, ["a", "b", "c"]);
  assert.equal(f.peak(), 1);
});

test("two threads overlap", { timeout: 5_000 }, async () => {
  const f = fake();
  const launchOn = perThread(f.run);
  const runs = [launchOn("T1", launch("a")), launchOn("T2", launch("b"))];
  await settle();
  assert.deepEqual(f.started, ["a", "b"]);
  assert.equal(f.peak(), 2);
  f.release();
  f.release();
  await Promise.all(runs);
});

test("a failed or timed-out run releases the thread, and the next request runs", { timeout: 5_000 }, async () => {
  const f = fake();
  const launchOn = perThread(f.run);
  const failed = launchOn("T", launch("fails"));
  const timeout = launchOn("T", launch("times-out"));
  const next = launchOn("T", launch("next"));
  await settle();
  f.release(new Error("runner failed"));
  await assert.rejects(failed, /runner failed/);
  await settle();
  assert.deepEqual(f.started, ["fails", "times-out"]);
  f.release(timedOut);
  assert.equal((await timeout).limit_hit, "timeout");
  await settle();
  assert.deepEqual(f.started, ["fails", "times-out", "next"]);
  f.release();
  assert.equal((await next).exit, 0);
});
