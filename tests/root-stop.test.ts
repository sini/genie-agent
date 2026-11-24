import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { type Inbound, INTERRUPTED, main } from "../src/root/index.ts";
import { piAiPath } from "../src/tier1/custody.ts";

const tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-root-stop-test-`);
process.env.GENIE_PI_AI = piAiPath(process.env.PI ?? "pi");

const slowPi = `${tmp}/slow-pi`;
const inlineJs = `
const { createInterface } = require("node:readline");
const mode = process.env.FAKE_PI_MODE || "slow";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "get_state") {
    process.stdout.write(JSON.stringify({ id: msg.id, type: "response", command: "get_state", success: true, data: {} }) + "\\n");
    return;
  }
  if (msg.type === "prompt") {
    if (mode === "fast") {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ id: msg.id, type: "response", command: "prompt", success: true }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\\n");
      }, 15);
    }
    // mode === "slow": hold prompt response in-flight until killed by supervisor.shutdown()
  }
});
`.replace(/'/g, "'\\''");
writeFileSync(slowPi, `#!/bin/sh\nexec "${process.execPath}" -e '${inlineJs}' -- "$@"\n`);
chmodSync(slowPi, 0o755);
for (const f of ["model", "s3", "token"]) writeFileSync(`${tmp}/${f}-key`, "k\n");

function makeConfig(piBin: string): string {
  const cfgPath = `${tmp}/config-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(
    cfgPath,
    JSON.stringify({
      stateRoot: `${tmp}/state`,
      storeRoot: `${tmp}/store`,
      repoUrlBase: "https://127.0.0.1:1",
      mirror: { mirrorRoot: `${tmp}/mirrors`, worktreeRoot: `${tmp}/worktrees`, exempt: ["127.0.0.1"] },
      pi: piBin,
      model: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", id: "m", keyFile: `${tmp}/model-key` },
      tier1: { searxngUrl: "http://127.0.0.1:1", cluster: [] },
      hindsightUrl: "http://127.0.0.1:1",
      s3: { endpoint: "http://127.0.0.1:1", region: "garage", bucket: "b", accessKeyId: "k", secretKeyFile: `${tmp}/s3-key` },
      broker: {
        tokenFile: `${tmp}/token-key`,
        githubApi: "http://127.0.0.1:1",
        threadLink: "https://chat.example.org/thread/{thread}",
        guardOut: { base: "http://127.0.0.1:1/v1", model: "m" },
      },
    }),
  );
  return cfgPath;
}

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeEnvelope(thread: string, text: string): string {
  return (
    `[matrix] room=#support:example.org thread=${thread} user=@alice:example.org (trusted)\n\n` +
    `<request>\n` +
    `${JSON.stringify({ sender: "@alice:example.org", sender_id: "@alice:example.org", tier: "trusted", addressed: true, text })}\n` +
    `</request>`
  );
}

test("root stop: slow in-flight model call aborts after grace, posts INTERRUPTED while io is open, clears pending, and exits well under TimeoutStopSec", async () => {
  process.env.FAKE_PI_MODE = "slow";
  const cfgPath = makeConfig(slowPi);
  const posts: { thread: string; payload: unknown; ioClosedAtPost: boolean }[] = [];
  let ioClosed = false;
  const controller = new AbortController();
  let delivered = false;
  const root = main(cfgPath, {
    intake: {
      next: async (): Promise<Inbound[] | null> => {
        if (delivered) {
          await new Promise<void>((r) => {
            if (controller.signal.aborted) r();
            else controller.signal.addEventListener("abort", () => r(), { once: true });
          });
          return null;
        }
        delivered = true;
        // Abort shortly after intake yields the item so handle() is in-flight in the slow model call.
        setTimeout(() => controller.abort(), 30);
        return [{ thread: "$stop_slow", envelope: makeEnvelope("$stop_slow", "slow question"), screened: true }];
      },
    },
    post: {
      post: async (t, m) => {
        posts.push({ thread: t, payload: m, ioClosedAtPost: ioClosed });
        return `$ev_${posts.length}`;
      },
    },
    xmsg: { send: async () => "m1" },
  });

  await root.start();
  const startedAt = Date.now();
  try {
    await root.run({ signal: controller.signal, graceMs: 60 });
  } finally {
    await root.stop();
    ioClosed = true;
  }
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 15_000, `expected bounded stop well under TimeoutStopSec (60s), took ${elapsedMs}ms`);
  assert.equal(posts.length, 1, "expected exactly one reply (interruption notice)");
  assert.equal(posts[0].thread, "$stop_slow");
  assert.deepEqual(posts[0].payload, { text: INTERRUPTED });
  assert.equal(posts[0].ioClosedAtPost, false, "interruption notice must be posted while io is still open");
  assert.deepEqual(root.store.pending("$stop_slow"), [], "pending entry must be cleared on aborted turn");
});

test("root stop: reply landing inside grace completes with exactly one reply and no interruption notice", async () => {
  const cfgPath = makeConfig(slowPi);
  const posts: { thread: string; payload: unknown }[] = [];
  const controller = new AbortController();
  let delivered = false;
  const root = main(cfgPath, {
    intake: {
      next: async (): Promise<Inbound[] | null> => {
        if (delivered) return null;
        delivered = true;
        setTimeout(() => controller.abort(), 5);
        return [
          {
            thread: "$stop_fast",
            expert: JSON.stringify({ answer: "in-grace answer", confidence: 0.9, tier: "expert", gaps: [] }),
          },
        ];
      },
    },
    post: {
      post: async (t, m) => {
        await new Promise((r) => setTimeout(r, 25));
        posts.push({ thread: t, payload: m });
        return `$ev_${posts.length}`;
      },
    },
    xmsg: { send: async () => "m1" },
  });

  await root.start();
  try {
    await root.run({ signal: controller.signal, graceMs: 2_000 });
  } finally {
    await root.stop();
  }

  assert.equal(posts.length, 1, "expected exactly one reply when turn settles inside grace");
  assert.equal(
    JSON.stringify(posts[0].payload).includes(INTERRUPTED),
    false,
    "must not post INTERRUPTED when reply lands inside grace",
  );
  assert.deepEqual(root.store.pending("$stop_fast"), []);
});
