import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

// Exercise the real entrypoint with gated dependencies, without exporting a test-only API.
const source = readFileSync(new URL("../src/root/main.ts", import.meta.url), "utf8");
const start = source.indexOf("async function run(");
const end = source.indexOf("\nconst isTestRunner", start);
assert.ok(start >= 0 && end > start, "root entrypoint changed; update the executable fixture");
const declaration = stripTypeScriptTypes(source.slice(start, end));

test("root startup: shutdown handlers precede intake while startup readiness is delayed", async () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    let release!: () => void;
    let resumed!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { resumed = resolve; });
    const signals = new EventEmitter();
    const order: string[] = [];
    let closed = false;
    class Io {
      async register(pump: boolean) { assert.equal(pump, false); order.push("registered"); }
      close() { closed = true; order.push("closed"); }
      resume() { order.push("poll"); signals.emit(signal); resumed(); }
    }
    const root = {
      async start() { order.push("starting"); await gate; order.push("ready"); },
      async run() { order.push("run"); },
      async stop() { order.push("stopped"); },
    };
    const run = new Function("readFileSync", "validateRootConfig", "XmsgIo", "main", "process", `${declaration}\nreturn run;`)(
      () => JSON.stringify({ xmsg: {} }), () => ({ guardEnable: false }), Io, () => root, signals,
    );
    const running = run({ configPath: "fixture", xmsgDir: "fixture" });
    try {
      await active;
      assert.ok(order.includes("starting"), "control did not hold startup readiness");
      assert.ok(!order.includes("ready"));
      assert.equal(closed, true, `${signal} before startup readiness was ignored`);
    } finally {
      release();
      await running;
    }
    assert.deepEqual(order, ["registered", "poll", "closed", "starting", "ready", "run", "stopped"]);
  }
});
