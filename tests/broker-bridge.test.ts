import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerBridge } from "../src/broker/bridge.ts";
const principal = { service: "gateway", node: "bus" };
const text = (value: unknown) =>
  `[External message via arbitrary@label; gateway correlation gw-${"a".repeat(64)}]\n${JSON.stringify(value)}`;
const read = { kind: "gist_read", id: "abc" };
test("broker bridge: attested allowlist, single proposal and body label cannot confer authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  let acts = 0;
  const replies: string[] = [];
  const b = new BrokerBridge({
    stateRoot: dir,
    allowlist: [principal],
    maxBodyBytes: 65536,
    propose: async () => {
      acts++;
      return { thread: "safe", acted: true, reason: "read", redactions: [] };
    },
    reply: async (_, v) => {
      replies.push(v);
    },
  });
  try {
    await b.start();
    await b.accept({
      id: "wrong",
      origin: { ...principal, node: "foreign" },
      text: text(read),
    });
    await b.accept({
      id: "malformed",
      origin: principal,
      text: text(read) + "\n" + JSON.stringify(read),
    });
    await b.accept({ id: "good", origin: principal, text: text(read) });
    await b.close();
    assert.equal(acts, 1);
    assert.equal(replies.length, 3);
    assert.equal(JSON.parse(replies[0]).acted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("broker bridge: durable duplicates replay, intake remains free, serialized UTF8 is bounded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  let acts = 0;
  const replies: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const config = {
    stateRoot: dir,
    allowlist: [principal],
    maxBodyBytes: 512,
    propose: async () => {
      acts++;
      await gate;
      return {
        thread: "safe",
        acted: true,
        reason: "😀".repeat(300),
        redactions: [],
      };
    },
    reply: async (_: string, v: string) => {
      replies.push(v);
    },
  };
  try {
    const b = new BrokerBridge(config);
    await b.start();
    await b.accept({ id: "one", origin: principal, text: text(read) });
    await b.accept({ id: "one", origin: principal, text: text(read) });
    release();
    await b.close();
    assert.equal(acts, 1);
    assert.ok(Buffer.byteLength(replies[0]) <= 512);
    assert.match(JSON.parse(replies[0]).reason, /too large/);
    const c = new BrokerBridge(config);
    await c.start();
    await c.accept({ id: "one", origin: principal, text: text(read) });
    await c.close();
    assert.equal(acts, 1);
    assert.ok(replies.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("broker bridge: startup never repeats uncertain writes and safely retries pending reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  let acts = 0;
  const replies: string[] = [];
  const config = {
    stateRoot: dir,
    allowlist: [principal],
    maxBodyBytes: 65536,
    propose: async () => {
      acts++;
      return { thread: "safe", acted: true, reason: "read", redactions: [] };
    },
    reply: async (_: string, v: string) => {
      replies.push(v);
    },
  };
  try {
    const b = new BrokerBridge(config);
    await b.start();
    await b.accept({
      id: "write",
      origin: principal,
      text: text({
        kind: "gist",
        title: "t",
        body: "b",
        files: { "x.txt": "x" },
      }),
    });
    await b.close();
    const fs = await import("node:fs");
    const file = fs.readdirSync(dir).find((v) => v.endsWith(".json"))!;
    const r = JSON.parse(fs.readFileSync(join(dir, file), "utf8"));
    r.state = "writing";
    delete r.result;
    r.proposal = {
      kind: "gist",
      title: "t",
      body: "b",
      files: { "x.txt": "x" },
    };
    fs.writeFileSync(join(dir, file), JSON.stringify(r));
    const c = new BrokerBridge(config);
    await c.start();
    await c.close();
    assert.equal(acts, 1);
    assert.match(JSON.parse(replies.at(-1)!).reason, /uncertain/);
    r.state = "pending";
    r.proposal = read;
    fs.writeFileSync(join(dir, file), JSON.stringify(r));
    const d = new BrokerBridge(config);
    await d.start();
    await d.close();
    assert.equal(acts, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("broker bridge: unsafe history is retained and capacity refuses before custody ACK", async () => {
  const fs = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  let acts = 0;
  const inbound = { id: "held", origin: principal, text: text(read) };
  const config = {
    stateRoot: dir,
    allowlist: [principal],
    maxBodyBytes: 65536,
    maxRecords: 1,
    maxQueued: 1,
    retentionMs: 1,
    propose: async () => {
      acts++;
      return { thread: "safe", acted: true, reason: "read", redactions: [] };
    },
    reply: async () => {},
  };
  try {
    const b = new BrokerBridge(config);
    await b.start();
    await b.accept(inbound);
    await b.close();
    const file = fs.readdirSync(dir).find((v) => v.endsWith(".json"))!;
    const r = JSON.parse(fs.readFileSync(join(dir, file), "utf8"));
    r.created = 0;
    fs.writeFileSync(join(dir, file), JSON.stringify(r));
    const c = new BrokerBridge(config);
    await c.start();
    await assert.rejects(c.accept({ ...inbound, id: "new" }), /capacity/);
    await c.accept(inbound);
    await c.acknowledge(inbound);
    await c.close();
    assert.equal(acts, 1);
    const d = new BrokerBridge(config);
    await d.start();
    await d.accept({ ...inbound, id: "new" });
    await d.close();
    assert.equal(acts, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("broker bridge: write marker precedes delegated Act and result precedes keyed reply", async () => {
  const fs = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  let acts = 0;
  let replies = 0;
  const record = () =>
    JSON.parse(
      fs.readFileSync(
        join(
          dir,
          fs.readdirSync(dir).find((v) => v.endsWith(".json"))!,
        ),
        "utf8",
      ),
    );
  const b = new BrokerBridge({
    stateRoot: dir,
    allowlist: [principal],
    maxBodyBytes: 65536,
    propose: async () => {
      acts++;
      assert.equal(record().state, "writing");
      return { thread: "safe", acted: true, reason: "acted", redactions: [] };
    },
    reply: async (id, v, key) => {
      replies++;
      assert.equal(id, "write");
      assert.match(key, /^broker-[a-f0-9]{64}$/);
      assert.equal(record().state, "completed");
      assert.equal(record().result, v);
    },
  });
  try {
    await b.start();
    await b.accept({
      id: "write",
      origin: principal,
      text: text({ kind: "gist_comment", id: "abc", body: "b" }),
    });
    await b.close();
    assert.equal(acts, 1);
    assert.equal(replies, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("broker bridge: bare proposal is refused and unavailable intake never permits ACK", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  let acts = 0;
  const replies: string[] = [];
  const b = new BrokerBridge({
    stateRoot: dir,
    allowlist: [principal],
    maxBodyBytes: 65536,
    propose: async () => {
      acts++;
      return { thread: "safe", acted: true, reason: "read", redactions: [] };
    },
    reply: async (_, v) => {
      replies.push(v);
    },
  });
  const inbound = { id: "bare", origin: principal, text: JSON.stringify(read) };
  try {
    await assert.rejects(b.accept(inbound), /unavailable/);
    await b.start();
    await b.accept(inbound);
    await b.close();
    assert.equal(acts, 0);
    assert.match(JSON.parse(replies[0]).reason, /invalid broker proposal/);
    await assert.rejects(b.accept({ ...inbound, id: "after" }), /unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("broker bridge: recovery stages retained records within the configured queue cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  let acts = 0;
  let replies = 0;
  const config = {
    stateRoot: dir,
    allowlist: [principal],
    maxBodyBytes: 65536,
    maxQueued: 3,
    propose: async () => {
      acts++;
      return { thread: "safe", acted: true, reason: "read", redactions: [] };
    },
    reply: async () => {
      replies++;
    },
  };
  try {
    const b = new BrokerBridge(config);
    await b.start();
    for (let n = 0; n < 3; n++)
      await b.accept({ id: String(n), origin: principal, text: text(read) });
    await b.close();
    assert.equal(acts, 3);
    const c = new BrokerBridge({
      ...config,
      maxQueued: 1,
      reply: async () => {
        assert.ok((c as unknown as { queue: string[] }).queue.length <= 1);
        replies++;
      },
    });
    await c.start();
    assert.equal((c as unknown as { queue: string[] }).queue.length, 1);
    await c.close();
    assert.equal(acts, 3);
    assert.equal(replies, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("broker bridge: a lower replay budget holds the immutable completed wire result", async () => {
  const fs = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  let acts = 0;
  const replies: { text: string; key: string }[] = [];
  const config = {
    stateRoot: dir,
    allowlist: [principal],
    maxBodyBytes: 65536,
    propose: async () => {
      acts++;
      return {
        thread: "safe",
        acted: true,
        reason: "x".repeat(1000),
        redactions: [],
      };
    },
    reply: async (_: string, text: string, key: string) => {
      replies.push({ text, key });
    },
  };
  const inbound = { id: "one", origin: principal, text: text(read) };
  try {
    const b = new BrokerBridge(config);
    await b.start();
    await b.accept(inbound);
    await b.close();
    const file = join(
      dir,
      fs.readdirSync(dir).find((v) => v.endsWith(".json"))!,
    );
    const original = JSON.parse(fs.readFileSync(file, "utf8")).result;
    const c = new BrokerBridge({ ...config, maxBodyBytes: 512 });
    await c.start();
    await c.accept(inbound);
    await c.close();
    assert.equal(acts, 1);
    assert.equal(replies.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).result, original);
    const d = new BrokerBridge(config);
    await d.start();
    await d.close();
    assert.equal(acts, 1);
    assert.deepEqual(replies[1], replies[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("broker bridge: contract changes durably refuse new custody without blocking replies and hold queued Acts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  let allowed = true;
  let acts = 0;
  let replies = 0;
  const b = new BrokerBridge({
    stateRoot: dir,
    allowlist: [principal],
    maxBodyBytes: 65536,
    checkContract: () => {
      if (!allowed) throw new Error("contract changed");
    },
    propose: async () => {
      acts++;
      return { thread: "safe", acted: true, reason: "read", redactions: [] };
    },
    reply: async () => {
      replies++;
    },
  });
  const inbound = { id: "one", origin: principal, text: text(read) };
  try {
    await b.start();
    await b.accept(inbound);
    allowed = false;
    const refused = { ...inbound, id: "two" };
    assert.equal(await b.accept(refused), true);
    await b.acknowledge(refused);
    assert.equal(await b.accept(inbound), true);
    await b.close();
    assert.equal(acts, 0);
    assert.equal(replies, 1);
    const fs = await import("node:fs");
    const rows = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(join(dir, f), "utf8")));
    const admitted = rows.find((r) => r.id === "one");
    const refusal = rows.find((r) => r.id === "two");
    assert.equal(admitted.state, "pending");
    assert.equal(admitted.result, undefined);
    assert.equal(refusal.state, "completed");
    assert.equal(refusal.acknowledged, true);
    assert.match(JSON.parse(refusal.result).reason, /contract changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
