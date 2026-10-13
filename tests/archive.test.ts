// The archive writer's gating oracle (plan P4), against a stub S3 that records every request: one
// archive is one PUT, holding the transcript, verdicts, escalation and actions (absent ones explicit),
// with the transcript byte-equal to pi's session file; a failed PUT rejects, so P3's collection
// removes nothing. Run with `node --test tests/archive.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { archiver, BUCKET, sign } from "../src/archive/index.ts";
import { Gc, IDLE_TTL_MS } from "../src/gc/index.ts";
import { type ThreadState, ThreadStateStore } from "../src/state/index.ts";

// S3, answering every request with HTTP `status` and recording its method, path, headers and body.
async function s3stub(status = 200) {
  const requests: { method: string; url: string; headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { endpoint: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

const tmp = mkdtempSync(`${tmpdir()}/genie-archive-test-`);
const keyFile = `${tmp}/secret`;
writeFileSync(keyFile, "secret-test\n");
const store = new ThreadStateStore(`${tmp}/state`, `${tmp}/store`);
const config = (endpoint: string, secretKeyFile = keyFile) => ({ endpoint, region: "garage", bucket: BUCKET, accessKeyId: "GKtest", secretKeyFile });

// A thread with a state record and, unless `bare`, pi's session file and C5's escalation record.
function thread(id: string, tier: ThreadState["sender_tier"], bare = false, st = store) {
  st.write({ thread_id: id, status: "closed", created: "2026-10-12T00:00:00Z", last_active: "2026-10-12T01:00:00Z", sender_tier: tier });
  if (bare) return {};
  // pi's file, at the path pi resumes from: `<session-dir>/<session-id>.jsonl`.
  const session = `${st.stateRoot}/${id}/session/thread.jsonl`;
  mkdirSync(`${st.stateRoot}/${id}/session`, { recursive: true });
  const transcript = `${JSON.stringify({ role: "user", content: `q ${randomUUID()} ünïcødé` })}\n${JSON.stringify({ role: "assistant", content: randomUUID() })}\n`;
  writeFileSync(session, transcript);
  // A decoy: the pending messages are not the transcript.
  st.setPending(id, [randomUUID()]);
  const escalation = { seq: 2, pkg: { cleaned_question: randomUUID(), draft: "d", eval_transcript: "", gaps: [] } };
  st.setEscalation(id, escalation);
  return { session, escalation };
}

test("oracle: close ⇒ exactly one PUT holding all four sections, absent ones explicit, the transcript pi's session file", async () => {
  const s3 = await s3stub();
  try {
    const { session, escalation } = thread("$close1", "public");
    await archiver(store, config(s3.endpoint))("$close1");
    assert.equal(s3.requests.length, 1);
    const [req] = s3.requests;
    assert.equal(req.method, "PUT");
    assert.equal(req.url, `/${BUCKET}/tier1/public/%24close1.json`);
    const obj = JSON.parse(req.body);
    for (const section of ["transcript", "verdicts", "escalation", "actions"]) assert.ok(section in obj, `section ${section} missing`);
    assert.equal(Buffer.compare(Buffer.from(obj.transcript, "utf8"), readFileSync(session!)), 0);
    assert.deepEqual(obj.escalation, escalation);
    assert.equal(obj.verdicts, null);
    assert.equal(obj.actions, null);
    assert.match(obj.absent.verdicts, /not persisted/);
    assert.match(obj.absent.actions, /not persisted/);
    assert.deepEqual(Object.keys(obj.absent).sort(), ["actions", "verdicts"]);
    assert.equal(obj.tier, "public");
  } finally {
    s3.close();
  }
});

test("oracle: a failed PUT rejects, so collection deletes nothing", async () => {
  const s3 = await s3stub(503);
  try {
    thread("$fail1", "public");
    await assert.rejects(archiver(store, config(s3.endpoint))("$fail1"), /HTTP 503/);
    assert.equal(s3.requests.length, 1);
  } finally {
    s3.close();
  }
  // Nothing listening at all.
  await assert.rejects(archiver(store, config(s3.endpoint))("$fail1"));
});

test("oracle: the key carries the thread's tier, and the two tiers never share a prefix", async () => {
  const s3 = await s3stub();
  try {
    thread("$pub", "public");
    thread("$tru", "trusted");
    const archive = archiver(store, config(s3.endpoint));
    await archive("$pub");
    await archive("$tru");
    assert.deepEqual(
      s3.requests.map((r) => r.url),
      [`/${BUCKET}/tier1/public/%24pub.json`, `/${BUCKET}/tier1/trusted/%24tru.json`],
    );
  } finally {
    s3.close();
  }
});

test("oracle: P3's collection of an expired thread, with this archiver, is exactly one PUT and then the thread is gone", async () => {
  const s3 = await s3stub();
  try {
    // Its own store, so the sweep sees this thread alone.
    const gcStore = new ThreadStateStore(`${tmp}/gc-state`, `${tmp}/gc-store`);
    thread("$gc1", "trusted", false, gcStore);
    const last = Date.parse("2026-10-12T01:00:00Z");
    const clock = { now: () => last + IDLE_TTL_MS + 1, setTimeout: () => 0, clearTimeout: () => {} };
    const mirror = { mirrorRoot: `${tmp}/mirrors`, worktreeRoot: `${tmp}/worktrees` };
    await new Gc({ store: gcStore, mirror, clock, archive: archiver(gcStore, config(s3.endpoint)) }).sweep();
    assert.deepEqual(
      s3.requests.map((r) => r.url),
      [`/${BUCKET}/tier1/trusted/%24gc1.json`],
    );
    assert.equal(existsSync(`${tmp}/gc-state/$gc1`), false);
  } finally {
    s3.close();
  }
});

test("archiving a thread twice writes the same key again, never a second object", async () => {
  const s3 = await s3stub();
  try {
    thread("$twice", "trusted");
    const archive = archiver(store, config(s3.endpoint));
    await archive("$twice");
    await archive("$twice");
    assert.equal(new Set(s3.requests.map((r) => r.url)).size, 1);
    assert.equal(JSON.parse(s3.requests[0].body).transcript, JSON.parse(s3.requests[1].body).transcript);
  } finally {
    s3.close();
  }
});

test("a thread closed before its first reply archives a null transcript with its reason", async () => {
  const s3 = await s3stub();
  try {
    thread("$early", "public", true);
    await archiver(store, config(s3.endpoint))("$early");
    const obj = JSON.parse(s3.requests[0].body);
    assert.equal(obj.transcript, null);
    assert.equal(obj.escalation, null);
    assert.deepEqual(Object.keys(obj.absent).sort(), ["actions", "escalation", "transcript", "verdicts"]);
  } finally {
    s3.close();
  }
});

test("an empty secret key file rejects before any request", async () => {
  const s3 = await s3stub();
  try {
    writeFileSync(`${tmp}/empty`, "\n");
    thread("$nokey", "public");
    await assert.rejects(archiver(store, config(s3.endpoint, `${tmp}/empty`))("$nokey"), /secret key empty/);
    assert.equal(s3.requests.length, 0);
  } finally {
    s3.close();
  }
});

test("the SigV4 signature equals botocore's S3SigV4Auth for the same request", () => {
  // Reference: botocore S3SigV4Auth(Credentials("GKtest", "secret-test"), "s3", "garage"), PUT of
  // `{"x":1}` at the URL below, its clock fixed at 2026-10-12T00:00:00Z.
  const { url, headers } = sign(config("http://127.0.0.1:3900"), "secret-test", "tier1/public/$ev1.json", '{"x":1}', new Date("2026-10-12T00:00:00Z"));
  assert.equal(url, "http://127.0.0.1:3900/genie-transcripts/tier1/public/%24ev1.json");
  assert.equal(headers["x-amz-date"], "20261012T000000Z");
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=GKtest/20261012/garage/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=8d53ef1ac53a6c0678cf67a3f1fb634f87ace8b314996b0454f8d6f668498c28",
  );
});
