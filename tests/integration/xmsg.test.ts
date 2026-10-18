// Integration gating oracles for xmsg addressing migration (AM-1, AM-2, AM-3, AM-4).
// Oracle 1: Guard round trip against real xmsg serve and mock ninfer.
//   Mutant: in src/guard/main.ts, register as "svc:genie-guard" instead of "genie-guard" => RED.
// Oracle 2: Two outstanding dispatcher sends through Delivery (D1b) to two instance fakes with distinct PIDs;
//   fakes reply in reverse order; turns matched by inReplyTo; asserts through dispatcher's own replies
//   and journal.
//   Mutant: in src/dispatcher/delivery.ts:132, matching any outstanding turn (|| true) => RED.
// Run with:
//   XMSG_BIN=<path> GENIE_GUARD_BIN=<path> node --test tests/xmsg-integration.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";

import { Delivery, Dispatcher, SocketXmsg, type Inbound } from "../../src/dispatcher/index.ts";

const XMSG_BIN = process.env.XMSG_BIN;
if (!XMSG_BIN || !existsSync(XMSG_BIN)) {
  throw new Error(`XMSG_BIN environment variable is required and must point to a valid executable (got: ${XMSG_BIN})`);
}

const GENIE_GUARD_BIN = process.env.GENIE_GUARD_BIN;
if (!GENIE_GUARD_BIN || !existsSync(GENIE_GUARD_BIN)) {
  throw new Error(
    `GENIE_GUARD_BIN environment variable is required and must point to a valid executable (got: ${GENIE_GUARD_BIN})`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getProcStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rparen = stat.lastIndexOf(")");
  const fields = stat.slice(rparen + 1).trim().split(/\s+/);
  return fields[19];
}

interface XmsgNode {
  child: ChildProcess;
  dir: string;
  runDir: string;
  xmsgDir: string;
  sessionsDir: string;
  httpSock: string;
  agentSock: string;
  registerSock: string;
  stop: () => Promise<void>;
}

async function startXmsg(svcExes: Record<string, string>): Promise<XmsgNode> {
  const dir = join(tmpdir(), `xmsg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const runDir = join(dir, "run");
  const xmsgDir = join(runDir, "xmsg");
  const sessionsDir = join(dir, "sessions");
  mkdirSync(xmsgDir, { recursive: true, mode: 0o700 });
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

  const httpSock = join(xmsgDir, "http.sock");
  const agentSock = join(xmsgDir, "agent.sock");
  const registerSock = join(xmsgDir, "register.sock");
  const dbPath = join(dir, "xmsg.db");

  const args = [
    "serve",
    "--db-path",
    dbPath,
    "--sessions-dir",
    sessionsDir,
    "--http-sock",
    httpSock,
    "--agent-sock",
    agentSock,
    "--register-sock",
    registerSock,
  ];
  for (const [name, exe] of Object.entries(svcExes)) {
    args.push("--svc-exe", `${name}=${exe}`);
  }

  const child = spawn(XMSG_BIN, args, {
    env: { ...process.env, XDG_RUNTIME_DIR: runDir, HOME: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        child.on("exit", () => r());
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          r();
        }, 3000);
      });
    }
    rmSync(dir, { recursive: true, force: true });
  };

  for (let i = 0; i < 200; i++) {
    if (existsSync(httpSock) && existsSync(agentSock) && existsSync(registerSock)) {
      return { child, dir, runDir, xmsgDir, sessionsDir, httpSock, agentSock, registerSock, stop };
    }
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`xmsg serve exited prematurely with code ${child.exitCode}`);
    }
    await sleep(25);
  }

  await stop();
  throw new Error("timed out waiting for xmsg sockets to appear");
}

function unixHttp(
  socketPath: string,
  method: string,
  path: string,
  body?: any,
): Promise<{ status: number; body: string; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined;
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers,
        agent: false,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-json response
          }
          resolve({ status: res.statusCode ?? 0, body: text, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// -----------------------------------------------------------------------------
// Oracle 1: Guard round trip
// - genie-guard registers under bare name "genie-guard" (no "svc:" prefix)
// - An envelope sent to genie-guard is reviewed via mock ninfer and the verdict replied
// Mutant: src/guard/main.ts registering as "svc:genie-guard" is refused by xmsg => RED.
// -----------------------------------------------------------------------------
test("oracle 1: guard round trip relays verdict and refuses svc: prefix", { timeout: 30_000 }, async () => {
  const node = await startXmsg({
    "genie-guard": GENIE_GUARD_BIN,
  });

  let ninferServer: ReturnType<typeof createHttpServer> | null = null;
  let guardProc: ChildProcess | null = null;

  try {
    // Start mock ninfer server
    let receivedPrompt = "";
    ninferServer = createHttpServer((req, res) => {
      let reqBody = "";
      req.on("data", (c) => (reqBody += c));
      req.on("end", () => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "mock-guard-model" }] }));
        }
        if (req.url === "/v1/chat/completions") {
          receivedPrompt = reqBody;
          res.writeHead(200, { "Content-Type": "application/json" });
          const verdict = {
            verdict: "allow",
            reason: "benign test envelope",
            cleaned_text: "",
          };
          return res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: JSON.stringify(verdict) } }],
            }),
          );
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((r) => ninferServer!.listen(0, "127.0.0.1", r));
    const ninferPort = (ninferServer.address() as any).port;
    const ninferUrl = `http://127.0.0.1:${ninferPort}/v1`;

    // Spawn genie-guard process
    guardProc = spawn(GENIE_GUARD_BIN, ["--ninfer-url", ninferUrl], {
      env: { ...process.env, XDG_RUNTIME_DIR: node.runDir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait until genie-guard registers with xmsg
    let registered = false;
    for (let i = 0; i < 200; i++) {
      const res = await unixHttp(node.httpSock, "GET", "/v1/recipients?kind=service");
      if (res.status === 200 && res.json?.recipients) {
        if (res.json.recipients.some((r: any) => r.address.startsWith("genie-guard"))) {
          registered = true;
          break;
        }
      }
      if (guardProc.exitCode !== null) {
        throw new Error(`genie-guard exited prematurely with code ${guardProc.exitCode}`);
      }
      await sleep(25);
    }
    assert.ok(registered, "genie-guard should register as service");

    // Send an envelope to genie-guard via xmsg HTTP POST /v1/messages
    const env = {
      source: "message",
      history: [{ sender: "@a:example.org", tier: "trusted", text: "earlier context" }],
      content: { sender: "@b:example.org", tier: "public", text: "how do I pin nixpkgs?" },
    };
    const sendRes = await unixHttp(node.httpSock, "POST", "/v1/messages", {
      to: "genie-guard",
      from: "oracle1-sender",
      text: JSON.stringify(env),
    });
    assert.equal(sendRes.status, 202, `POST /v1/messages should return 202: ${sendRes.body}`);
    const messageId = sendRes.json?.message_id;
    assert.ok(messageId, "send should return message_id");

    // Wait for genie-guard to reply via GET /v1/messages/:id/replies?wait=5
    const replyRes = await unixHttp(node.httpSock, "GET", `/v1/messages/${messageId}/replies?wait=5`);
    assert.equal(replyRes.status, 200, `GET replies should return 200: ${replyRes.body}`);
    assert.ok(Array.isArray(replyRes.json) && replyRes.json.length > 0, "should have at least one reply");

    const reply = JSON.parse(replyRes.json[0].text);
    assert.equal(reply.verdict, "allow");
    assert.equal(reply.cleaned_text, "");
    assert.ok(receivedPrompt.length > 0, "ninfer chat completion should have received a request");
  } finally {
    if (guardProc && guardProc.exitCode === null) {
      guardProc.kill("SIGTERM");
      await sleep(50);
      if (guardProc.exitCode === null) guardProc.kill("SIGKILL");
    }
    if (ninferServer) {
      ninferServer.close();
      ninferServer.closeAllConnections();
    }
    await node.stop();
  }
});

// -----------------------------------------------------------------------------
// Oracle 2: Two outstanding dispatcher sends through Delivery (D1b) to two instance fakes
// - Real Delivery and Dispatcher connected to real xmsg serve via SocketXmsg("genie-expert")
// - Two distinct child processes running instance fakes with distinct PIDs
// - Fakes reply in reverse order (inst-2 replies before inst-1)
// - Turns are matched by inReplyTo in Delivery.receive(): each supervisor message receives
//   its own turn's reply, verified through xmsg replies and Dispatcher journal
// Mutant: src/dispatcher/delivery.ts:132 matching any outstanding send (|| true) => RED
// -----------------------------------------------------------------------------
test(
  "oracle 2: two outstanding dispatcher sends matched by inReplyTo in reverse arrival order",
  { timeout: 30_000 },
  async () => {
    // node executable is trusted as genie-expert
    const node = await startXmsg({
      "genie-expert": process.execPath,
    });

    // Helper to spawn an instance fake child process with a distinct PID
    const spawnInstanceFake = (sessionId: string) => {
      const inboxSock = join(node.xmsgDir, `${sessionId}-inbox.sock`);
      const childCode = `
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");

const [sessionId, inboxSock, sessionsDir, httpSock] = process.argv.slice(1);

function getProcStart(pid) {
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  const rparen = stat.lastIndexOf(")");
  const fields = stat.slice(rparen + 1).trim().split(/\\s+/);
  return fields[19];
}

const server = net.createServer((c) => {
  let buf = "";
  c.setEncoding("utf8");
  c.on("data", (chunk) => {
    buf += chunk;
    const match = buf.match(/message_id=([^\\s—]+)/);
    if (match) {
      process.stdout.write("DELIVERED " + match[1] + "\\n");
    }
  });
});

server.listen(inboxSock, () => {
  const sessionData = {
    pid: process.pid,
    sessionId: sessionId,
    name: sessionId,
    cwd: "/tmp",
    status: "idle",
    kind: "interactive",
    startedAt: 1,
    updatedAt: 2,
    procStart: getProcStart(process.pid),
    messagingSocketPath: inboxSock,
  };
  fs.writeFileSync(sessionsDir + "/" + process.pid + "_" + sessionId + ".json", JSON.stringify(sessionData));
  process.stdout.write("READY " + process.pid + "\\n");
});

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  while (stdinBuf.includes("\\n")) {
    const nl = stdinBuf.indexOf("\\n");
    const line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (line.startsWith("REPLY ")) {
      const [_, msgId, ...textParts] = line.split(" ");
      const text = textParts.join(" ");
      const body = JSON.stringify({ text });
      const req = http.request({
        socketPath: httpSock,
        path: "/v1/messages/" + encodeURIComponent(msgId) + "/replies",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        agent: false,
      }, (res) => {
        res.resume();
        res.on("end", () => {
          process.stdout.write("REPLIED " + msgId + "\\n");
        });
      });
      req.write(body);
      req.end();
    }
  }
});
`;

      const child = spawn(process.execPath, ["-e", childCode, sessionId, inboxSock, node.sessionsDir, node.httpSock], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutBuf = "";
      const lines: string[] = [];
      const waiters: { prefix: string; resolve: (line: string) => void }[] = [];

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        while (stdoutBuf.includes("\n")) {
          const nl = stdoutBuf.indexOf("\n");
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          lines.push(line);
          const idx = waiters.findIndex((w) => line.startsWith(w.prefix));
          if (idx !== -1) {
            const [w] = waiters.splice(idx, 1);
            w.resolve(line);
          }
        }
      });

      const waitLine = (prefix: string): Promise<string> => {
        const found = lines.find((l) => l.startsWith(prefix));
        if (found) return Promise.resolve(found);
        return new Promise((resolve) => waiters.push({ prefix, resolve }));
      };

      const sendCmd = (cmd: string) => {
        child.stdin.write(`${cmd}\n`);
      };

      const stop = async () => {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await sleep(50);
          if (child.exitCode === null) child.kill("SIGKILL");
        }
        try {
          rmSync(inboxSock, { force: true });
        } catch {
          // ignore
        }
      };

      return { child, waitLine, sendCmd, stop };
    };

    const inst1 = spawnInstanceFake("inst-1");
    const inst2 = spawnInstanceFake("inst-2");

    const dispatcherXmsg = new SocketXmsg(node.xmsgDir, "genie-expert");
    let del: Delivery | null = null;

    try {
      // Wait for both instance fakes to be ready
      const ready1 = await inst1.waitLine("READY");
      const ready2 = await inst2.waitLine("READY");
      const pid1 = parseInt(ready1.split(" ")[1], 10);
      const pid2 = parseInt(ready2.split(" ")[1], 10);
      assert.notEqual(pid1, pid2, "instance fakes must have distinct PIDs");

      // Register dispatcher on register.sock
      await dispatcherXmsg.register();

      // Open real Dispatcher and configure threads
      const stateDir = join(node.dir, "dispatcher-state");
      mkdirSync(stateDir, { recursive: true });

      const d = await Dispatcher.open({
        stateDir,
        herdr: {
          start: async () => "p1",
          close: async () => {},
          list: async () => [{ pane: "p1" }, { pane: "p2" }],
        },
        xmsg: dispatcherXmsg,
        pickToken: () => ({ id: "tok-1", configDir: "/tmp" }),
        cwd: "/tmp",
      });

      const t1 = d.thread("thread-1");
      t1.session = "inst-1";
      t1.state = "live";
      t1.pane = "p1";
      t1.launched = true;

      const t2 = d.thread("thread-2");
      t2.session = "inst-2";
      t2.state = "live";
      t2.pane = "p2";
      t2.launched = true;
      d.save();

      // Wire real Delivery
      del = new Delivery(d, dispatcherXmsg, {
        threadOf: (m: Inbound) => m.text.split(":")[0],
        replyTimeoutMs: 15_000,
      });
      del.start();

      // Send two supervisor messages to genie-expert via xmsg HTTP POST /v1/messages
      const supSend1 = await unixHttp(node.httpSock, "POST", "/v1/messages", {
        to: "genie-expert",
        from: "supervisor",
        text: "thread-1:question 1",
      });
      assert.equal(supSend1.status, 202);
      const supMsg1Id = supSend1.json?.message_id;
      assert.ok(supMsg1Id, "supervisor message 1 must have id");

      const supSend2 = await unixHttp(node.httpSock, "POST", "/v1/messages", {
        to: "genie-expert",
        from: "supervisor",
        text: "thread-2:question 2",
      });
      assert.equal(supSend2.status, 202);
      const supMsg2Id = supSend2.json?.message_id;
      assert.ok(supMsg2Id, "supervisor message 2 must have id");

      // Pump delivery twice to consume inbound supervisor messages and forward them to instances
      const pumped1 = await del.pump(5000);
      assert.equal(pumped1, true, "delivery must pump first supervisor message");
      const pumped2 = await del.pump(5000);
      assert.equal(pumped2, true, "delivery must pump second supervisor message");

      // Wait for drains to settle
      await del.settled();

      // Check both threads now have outstanding sends in the journal
      assert.equal(t1.outstanding.length, 1, "thread-1 must have 1 outstanding send");
      assert.equal(t2.outstanding.length, 1, "thread-2 must have 1 outstanding send");

      const sent1Id = t1.outstanding[0].sent;
      const sent2Id = t2.outstanding[0].sent;
      assert.notEqual(sent1Id, sent2Id, "sent IDs must differ");

      // Wait for both instance fakes to receive their forwarded messages
      await inst1.waitLine(`DELIVERED ${sent1Id}`);
      await inst2.waitLine(`DELIVERED ${sent2Id}`);

      // Now fakes reply in REVERSE order: inst-2 replies first, inst-1 replies second
      inst2.sendCmd(`REPLY ${sent2Id} Reply 2`);
      await inst2.waitLine(`REPLIED ${sent2Id}`);

      inst1.sendCmd(`REPLY ${sent1Id} Reply 1`);
      await inst1.waitLine(`REPLIED ${sent1Id}`);

      // Pump delivery twice to consume pushed replies and resolve turns
      const pumpedReply1 = await del.pump(5000);
      assert.equal(pumpedReply1, true, "delivery must pump first pushed reply");
      const pumpedReply2 = await del.pump(5000);
      assert.equal(pumpedReply2, true, "delivery must pump second pushed reply");

      // Both outstanding sends must be cleared by Delivery
      assert.equal(t1.outstanding.length, 0, "thread-1 outstanding must be cleared");
      assert.equal(t2.outstanding.length, 0, "thread-2 outstanding must be cleared");

      // Verify that each supervisor message received its own turn's reply from Delivery
      const m1Replies = await unixHttp(node.httpSock, "GET", `/v1/messages/${encodeURIComponent(supMsg1Id)}/replies?wait=2`);
      assert.equal(m1Replies.status, 200);
      assert.ok(Array.isArray(m1Replies.json) && m1Replies.json.length > 0, "supervisor msg 1 must have reply");
      assert.equal(m1Replies.json[0].text, "Reply 1", "thread-1 turn must be answered with Reply 1");

      const m2Replies = await unixHttp(node.httpSock, "GET", `/v1/messages/${encodeURIComponent(supMsg2Id)}/replies?wait=2`);
      assert.equal(m2Replies.status, 200);
      assert.ok(Array.isArray(m2Replies.json) && m2Replies.json.length > 0, "supervisor msg 2 must have reply");
      assert.equal(m2Replies.json[0].text, "Reply 2", "thread-2 turn must be answered with Reply 2");
    } finally {
      del?.stop();
      dispatcherXmsg.close();
      await inst1.stop();
      await inst2.stop();
      await node.stop();
    }
  },
);

// -----------------------------------------------------------------------------
// Oracle 3 (GI-2): XmsgGuardClient over real SocketXmsg and real xmsg serve
// - Enforces FIFO concurrency limit (maxConcurrency: 1) over 3 parallel checks
// - Fails closed to { unavailable } when timeout elapses
// -----------------------------------------------------------------------------
import { chmodSync } from "node:fs";
import { main as rootMain, XmsgGuardClient, XmsgIo } from "../../src/root/index.ts";
import { BRIDGE } from "../../src/supervisor/index.ts";
import type { Envelope } from "../../src/guard/verdict.ts";

test(
  "oracle 3 (GI-2): XmsgGuardClient enforces FIFO concurrency limit over 3 parallel checks and fails closed on timeout",
  { timeout: 30_000 },
  async () => {
    const node = await startXmsg({
      "genie": process.execPath,
      "genie-guard": process.execPath,
    });

    const callerXmsg = new SocketXmsg(node.xmsgDir, "genie");
    const guardCode = `
const { SocketXmsg } = require(${JSON.stringify(new URL("../../src/dispatcher/xmsg.ts", import.meta.url).pathname)});
const [xmsgDir] = process.argv.slice(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const x = new SocketXmsg(xmsgDir, "genie-guard");
  await x.register();
  let inFlight = 0;
  let peak = 0;
  const order = [];
  process.stdout.write("READY\\n");
  for (let i = 0; i < 3; i++) {
    const m = await x.poll(10000);
    if (!m) break;
    inFlight++;
    if (inFlight > peak) peak = inFlight;
    const env = JSON.parse(m.text);
    order.push(env.content.text);
    await sleep(60);
    inFlight--;
    await x.reply(m.id, JSON.stringify({ verdict: "allow", reason: "ok:" + env.content.text, cleaned_text: "" }));
    await x.ack(m.id);
  }
  process.stdout.write("STATS " + JSON.stringify({ peak, order }) + "\\n");
  // Fourth check (timeout test): poll it and hold without replying
  await x.poll(10000).catch(() => {});
})();
`;
    const guardChild = spawn(process.execPath, ["-e", guardCode, node.xmsgDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const guardLines: string[] = [];
    guardChild.stdout.setEncoding("utf8");
    guardChild.stdout.on("data", (c: string) => {
      for (const l of c.split("\n").filter(Boolean)) guardLines.push(l.trim());
    });
    const waitGuardLine = async (prefix: string) => {
      for (let i = 0; i < 200; i++) {
        const found = guardLines.find((l) => l.startsWith(prefix));
        if (found) return found;
        await sleep(25);
      }
      throw new Error(`timed out waiting for guard line ${prefix}; got: ${JSON.stringify(guardLines)}`);
    };

    try {
      await callerXmsg.register();
      await waitGuardLine("READY");

      const guardClient = new XmsgGuardClient(callerXmsg, {
        target: "genie-guard",
        maxConcurrency: 1,
        timeoutMs: 5_000,
      });

      let pumpRunning = true;
      const pumpCallerPromise = (async () => {
        while (pumpRunning) {
          const m = await callerXmsg.poll(1_000).catch(() => null);
          if (!m) continue;
          if (m.inReplyTo) guardClient.routeReply(m.inReplyTo, m.text);
          await callerXmsg.ack(m.id).catch(() => {});
        }
      })();

      const makeEnv = (text: string): Envelope => ({
        source: "message",
        history: [],
        content: { sender: "@u:example.org", tier: "public", text },
      });

      const [v1, v2, v3] = await Promise.all([
        guardClient.check(makeEnv("q1")),
        guardClient.check(makeEnv("q2")),
        guardClient.check(makeEnv("q3")),
      ]);
      const statsLine = await waitGuardLine("STATS ");
      const stats = JSON.parse(statsLine.slice("STATS ".length));

      assert.equal(guardClient.peakConcurrency, 1, "XmsgGuardClient peak active concurrency must be 1");
      assert.equal(stats.peak, 1, "genie-guard must never observe >1 concurrent request");
      assert.deepEqual(stats.order, ["q1", "q2", "q3"], "FIFO order must be preserved across 3 parallel checks");
      assert.deepEqual(v1, { verdict: "allow", reason: "ok:q1", cleaned_text: "" });
      assert.deepEqual(v2, { verdict: "allow", reason: "ok:q2", cleaned_text: "" });
      assert.deepEqual(v3, { verdict: "allow", reason: "ok:q3", cleaned_text: "" });

      // Timeout fails closed to { unavailable } when guard does not reply
      const fastTimeoutClient = new XmsgGuardClient(callerXmsg, {
        target: "genie-guard",
        maxConcurrency: 1,
        timeoutMs: 80,
      });
      const timedOut = await fastTimeoutClient.check(makeEnv("q-timeout"));
      assert.ok("unavailable" in timedOut, `expected { unavailable } on timeout, got ${JSON.stringify(timedOut)}`);
      assert.match(timedOut.unavailable, /timed out/);

      pumpRunning = false;
      callerXmsg.close();
      await pumpCallerPromise;
    } finally {
      callerXmsg.close();
      if (guardChild.exitCode === null) guardChild.kill("SIGKILL");
      await node.stop();
    }
  },
);

// -----------------------------------------------------------------------------
// Oracle 4 (GI-2): Full composition root over XmsgIo and real xmsg serve
// - Simulated matrix-xmsg forward to `genie` passes XmsgGuardClient (with 3 parallel guard checks
//   verifying concurrency limit = 1)
// - Runs fake `pi`, posts draft as an xmsg reply to the forward
// - Routes an escalation to a fake expert (`genie-expert`), whose reply is matched by `inReplyTo`
//   and posted back as an xmsg reply to the thread's forward
// - Also verifies `genie-root` package wrapper exposes `pi`, `bwrap`, `nix`, `git`, and
//   `NIX_SSL_CERT_FILE`.
// -----------------------------------------------------------------------------
test(
  "oracle 4 (GI-2): simulated matrix-xmsg forward to genie passes guard, runs fake pi, replies draft, and routes escalation to fake expert matched by inReplyTo",
  { timeout: 30_000 },
  async () => {
    const GENIE_ROOT_BIN = process.env.GENIE_ROOT_BIN;
    if (GENIE_ROOT_BIN) {
      assert.ok(existsSync(GENIE_ROOT_BIN), `GENIE_ROOT_BIN must exist: ${GENIE_ROOT_BIN}`);
      const wrapperText = readFileSync(GENIE_ROOT_BIN, "utf8");
      for (const tool of ["pi-coding-agent", "bubblewrap", "nix", "git"]) {
        assert.match(wrapperText, new RegExp(tool), `genie-root wrapper PATH must include ${tool}`);
      }
      assert.match(wrapperText, /NIX_SSL_CERT_FILE/, "genie-root wrapper must set NIX_SSL_CERT_FILE");
    }

    const node = await startXmsg({
      "genie": process.execPath,
      "genie-guard": GENIE_GUARD_BIN,
      "genie-expert": process.execPath,
    });

    const io = new XmsgIo({
      xmsgDir: node.xmsgDir,
      service: "genie",
      pollWaitMs: 500,
      guard: { target: "genie-guard", maxConcurrency: 1, timeoutMs: 10_000 },
    });

    let ninferServer: ReturnType<typeof createHttpServer> | null = null;
    let guardProc: ChildProcess | null = null;
    let expertProc: ChildProcess | null = null;
    let root: ReturnType<typeof rootMain> | null = null;

    try {
      // Stub ninfer server serving both genie-guard (guard-in) and root (guard-out), tracking guard-in concurrency
      let activeGuardIn = 0;
      let peakGuardIn = 0;
      let totalGuardIn = 0;
      ninferServer = createHttpServer((req, res) => {
        let reqBody = "";
        req.on("data", (c) => (reqBody += c));
        req.on("end", async () => {
          if (req.url === "/v1/models") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ data: [{ id: "m" }] }));
          }
          if (req.url === "/v1/chat/completions") {
            const isGuardOut = reqBody.includes("answer_under_review");
            if (isGuardOut) {
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(
                JSON.stringify({
                  choices: [
                    {
                      finish_reason: "stop",
                      message: { content: JSON.stringify({ verdict: "pass", reason: "clean" }) },
                    },
                  ],
                }),
              );
            }
            activeGuardIn++;
            totalGuardIn++;
            if (activeGuardIn > peakGuardIn) peakGuardIn = activeGuardIn;
            await sleep(40);
            activeGuardIn--;
            let cleaned_text = "";
            try {
              const parsed = JSON.parse(reqBody);
              const userContent = JSON.parse(parsed.messages?.at(-1)?.content ?? "{}");
              if (userContent.source !== "message" && typeof userContent.content?.text === "string") {
                cleaned_text = userContent.content.text;
              }
            } catch {}
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      content: JSON.stringify({
                        verdict: "allow",
                        reason: "clean",
                        cleaned_text,
                      }),
                    },
                  },
                ],
              }),
            );
          }
          res.writeHead(404).end();
        });
      });
      await new Promise<void>((r) => ninferServer!.listen(0, "127.0.0.1", r));
      const ninferPort = (ninferServer.address() as any).port;
      const ninferUrl = `http://127.0.0.1:${ninferPort}/v1`;

      // Spawn real genie-guard process in its own PID
      guardProc = spawn(GENIE_GUARD_BIN, ["--ninfer-url", ninferUrl], {
        env: { ...process.env, XDG_RUNTIME_DIR: node.runDir },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Spawn fake genie-expert service in its own PID that polls 2 escalations and replies in reverse order
      const expertCode = `
const { SocketXmsg } = require(${JSON.stringify(new URL("../../src/dispatcher/xmsg.ts", import.meta.url).pathname)});
const [xmsgDir] = process.argv.slice(1);
(async () => {
  const x = new SocketXmsg(xmsgDir, "genie-expert");
  await x.register();
  process.stdout.write("EXPERT_READY\\n");
  const esc1 = await x.poll(15000);
  if (!esc1) process.exit(1);
  await x.ack(esc1.id);
  const esc2 = await x.poll(15000);
  if (!esc2) process.exit(1);
  await x.ack(esc2.id);
  const t1 = JSON.parse(esc1.text).thread_id;
  const t2 = JSON.parse(esc2.text).thread_id;
  // Reply in reverse order (esc2 first, then esc1)
  await x.reply(esc2.id, "Expert answer for " + t2);
  await x.reply(esc1.id, "Expert answer for " + t1);
  process.stdout.write("EXPERT_DONE " + t1 + " " + t2 + "\\n");
})();
`;
      expertProc = spawn(process.execPath, ["-e", expertCode, node.xmsgDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const expertLines: string[] = [];
      expertProc.stdout?.setEncoding("utf8");
      expertProc.stdout?.on("data", (c: string) => {
        for (const l of c.split("\n").filter(Boolean)) expertLines.push(l.trim());
      });

      // Wait until genie-guard and genie-expert are registered
      for (let i = 0; i < 200; i++) {
        const res = await unixHttp(node.httpSock, "GET", "/v1/recipients?kind=service");
        const addrs: string[] = (res.json?.recipients ?? []).map((r: any) => r.address);
        if (
          addrs.some((a) => a.startsWith("genie-guard")) &&
          addrs.some((a) => a.startsWith("genie-expert"))
        ) {
          break;
        }
        await sleep(25);
      }

      await io.register();

      // Setup fake pi executable that records prompts and accepts bridge commands
      const piDir = join(node.dir, "pi-record");
      mkdirSync(piDir, { recursive: true });
      process.env.PI_RECORD = piDir;
      const fakePiScript = new URL("../fixtures/supervisor/fake-pi.ts", import.meta.url).pathname;
      const piBin = join(node.dir, "fake-pi");
      writeFileSync(
        piBin,
        `#!/bin/sh\nexport PI_RECORD="${piDir}"\nexport PI_SETTLE=manual\nexec "${process.execPath}" "${fakePiScript}" "$@"\n`,
      );
      chmodSync(piBin, 0o755);

      const modelKey = join(node.dir, "model-key");
      writeFileSync(modelKey, "stub-key\n");

      const cfgPath = join(node.dir, "config.json");
      writeFileSync(
        cfgPath,
        JSON.stringify({
          stateRoot: join(node.dir, "state"),
          storeRoot: join(node.dir, "store"),
          mirror: { mirrorRoot: join(node.dir, "mirrors"), worktreeRoot: join(node.dir, "worktrees") },
          pi: piBin,
          model: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", id: "m", keyFile: modelKey },
          tier1: { searxngUrl: "http://127.0.0.1:1", cluster: [] },
          s3: null,
          experts: {
            public: "genie-expert",
            trusted: "genie-expert",
          },
          broker: {
            guardOut: { base: ninferUrl, model: "m" },
          },
        }),
      );

      root = rootMain(cfgPath, io, async () => ({
        exit: 0,
        stdout_tail: "42",
        stderr_tail: "",
        limit_hit: "none",
      }));
      const runLoop = root.run();

      // Verify 3 parallel checks through io.guard respect maxConcurrency = 1
      const [g1, g2, g3] = await Promise.all([
        io.guard.check({ source: "message", history: [], content: { sender: "@u:x", tier: "public", text: "p1" } }),
        io.guard.check({ source: "message", history: [], content: { sender: "@u:x", tier: "public", text: "p2" } }),
        io.guard.check({ source: "message", history: [], content: { sender: "@u:x", tier: "public", text: "p3" } }),
      ]);
      assert.equal((g1 as any).verdict, "allow");
      assert.equal((g2 as any).verdict, "allow");
      assert.equal((g3 as any).verdict, "allow");
      assert.equal(io.guard.peakConcurrency, 1, "io.guard peakConcurrency over 3 parallel checks must be 1");
      assert.equal(peakGuardIn, 1, "genie-guard ninfer peak concurrent checks must be 1");

      // Send two simulated matrix-xmsg forwards to `genie` for threads $th1 and $th2
      const makeMatrixForward = (thread: string, text: string) =>
        `[matrix] room=#support:example.org thread=${thread} user=bob (public)\n\n<request>\n${JSON.stringify({
          sender: "bob",
          sender_id: "@bob:example.org",
          tier: "public",
          text,
        })}\n</request>`;

      const fwd1Res = await unixHttp(node.httpSock, "POST", "/v1/messages", {
        to: "genie",
        from: "matrix-xmsg",
        text: makeMatrixForward("$th1", "how do I enable flakes in thread 1?"),
      });
      assert.equal(fwd1Res.status, 202);
      const fwd1Id = fwd1Res.json?.message_id;
      assert.ok(fwd1Id);

      const fwd2Res = await unixHttp(node.httpSock, "POST", "/v1/messages", {
        to: "genie",
        from: "matrix-xmsg",
        text: makeMatrixForward("$th2", "how do I enable flakes in thread 2?"),
      });
      assert.equal(fwd2Res.status, 202);
      const fwd2Id = fwd2Res.json?.message_id;
      assert.ok(fwd2Id);

      // Wait until both fake pi processes are spawned by the supervisor
      for (let i = 0; i < 200; i++) {
        if (root.supervisor.pid("$th1") !== undefined && root.supervisor.pid("$th2") !== undefined) break;
        await sleep(25);
      }
      assert.ok(root.supervisor.pid("$th1") !== undefined, "fake pi for $th1 must be running");
      assert.ok(root.supervisor.pid("$th2") !== undefined, "fake pi for $th2 must be running");

      // Both threads call Host.reply with escalate_forced: true so both post drafts and escalate to genie-expert
      const draft1 = {
        answer: "draft answer for thread 1",
        confidence: 0.5,
        gaps: ["need expert check 1"],
        escalate_forced: true,
      };
      const draft2 = {
        answer: "draft answer for thread 2",
        confidence: 0.5,
        gaps: ["need expert check 2"],
        escalate_forced: true,
      };

      const reply1Cmd = await root.supervisor.command("$th1", {
        type: "host",
        title: BRIDGE,
        placeholder: JSON.stringify({ method: "reply", arg: draft1 }),
      });
      const reply1Val = JSON.parse((reply1Cmd.data as any).value);
      assert.equal(reply1Val.ok.posted, true);
      assert.ok(reply1Val.ok.escalated, "thread 1 must escalate to genie-expert");

      const reply2Cmd = await root.supervisor.command("$th2", {
        type: "host",
        title: BRIDGE,
        placeholder: JSON.stringify({ method: "reply", arg: draft2 }),
      });
      const reply2Val = JSON.parse((reply2Cmd.data as any).value);
      assert.equal(reply2Val.ok.posted, true);
      assert.ok(reply2Val.ok.escalated, "thread 2 must escalate to genie-expert");

      // Wait for both expert replies (sent in reverse order by expertProc) to be posted back to fwd1 and fwd2
      let fwd1All: any[] = [];
      let fwd2All: any[] = [];
      for (let i = 0; i < 200; i++) {
        const r1 = await unixHttp(node.httpSock, "GET", `/v1/messages/${encodeURIComponent(fwd1Id)}/replies`);
        const r2 = await unixHttp(node.httpSock, "GET", `/v1/messages/${encodeURIComponent(fwd2Id)}/replies`);
        fwd1All = r1.json ?? [];
        fwd2All = r2.json ?? [];
        if (fwd1All.length >= 2 && fwd2All.length >= 2) break;
        await sleep(25);
      }

      assert.equal(fwd1All.length, 2, "fwd1 must have draft reply + expert reply");
      assert.equal(fwd2All.length, 2, "fwd2 must have draft reply + expert reply");
      assert.deepEqual(JSON.parse(fwd1All[0].text), { text: JSON.stringify(draft1) });
      assert.deepEqual(JSON.parse(fwd2All[0].text), { text: JSON.stringify(draft2) });
      assert.deepEqual(JSON.parse(fwd1All[1].text), { text: "Expert answer for $th1" });
      assert.deepEqual(JSON.parse(fwd2All[1].text), { text: "Expert answer for $th2" });
      assert.ok(totalGuardIn >= 11, `expected >= 11 guard-in checks (3 parallel + 2 guardIn + 6 escalationGuard), got ${totalGuardIn}`);

      io.close();
      await runLoop;
    } finally {
      io.close();
      if (guardProc && guardProc.exitCode === null) guardProc.kill("SIGKILL");
      if (expertProc && expertProc.exitCode === null) expertProc.kill("SIGKILL");
      if (root) await root.stop();
      if (ninferServer) {
        ninferServer.close();
        ninferServer.closeAllConnections();
      }
      await node.stop();
    }
  },
);

// -----------------------------------------------------------------------------
// Mutant check (GI-2):
// - Mutant 1: inReplyTo matching dropped (matchByInReplyTo: false) => expert reply for thread 2
//   arriving first is misrouted to thread 1 => RED
// - Mutant 2: concurrency limit removed (maxConcurrency: Infinity) => 3 parallel checks overlap
//   with peakConcurrency > 1 => RED
// -----------------------------------------------------------------------------
test(
  "mutant (GI-2): dropping inReplyTo matching or removing concurrency limit goes RED",
  async () => {
    // Mutant 1: matchByInReplyTo: false misroutes reverse-order expert replies
    const posted: [string, string][] = [];
    const sentIds: string[] = [];
    const pollQueue: { id: string; text: string; inReplyTo?: string }[] = [];
    const fakeClient = {
      register: async () => ({ address: "genie@node", node: "node" }),
      close: () => {},
      poll: async () => pollQueue.shift() ?? null,
      ack: async () => {},
      send: async (_to: string, _text: string, _key: string) => {
        const id = `esc-${sentIds.length + 1}`;
        sentIds.push(id);
        return id;
      },
      reply: async (id: string, text: string) => {
        posted.push([id, text]);
      },
      list: async () => [],
      replies: async () => [],
    };

    const mutantIo = new XmsgIo({ matchByInReplyTo: false, pollWaitMs: 10 }, fakeClient);
    await mutantIo.xmsg.send("genie-expert", JSON.stringify({ thread_id: "$th1" }), "$th1#1");
    await mutantIo.xmsg.send("genie-expert", JSON.stringify({ thread_id: "$th2" }), "$th2#1");

    // Push expert reply for esc-2 ($th2) first
    pollQueue.push({ id: "rep-2", inReplyTo: "esc-2", text: "Expert answer for thread 2" });
    await mutantIo.register();
    const batch = await mutantIo.intake.next();
    mutantIo.close();

    assert.ok(batch && batch.length === 1);
    assert.throws(
      () => {
        assert.deepEqual(batch[0], { thread: "$th2", expert: "Expert answer for thread 2" });
      },
      /AssertionError/,
      "Mutant 1 (dropping inReplyTo matching) must fail RED when expert replies arrive out of order",
    );

    // Mutant 2: removing concurrency limit (maxConcurrency: 3 instead of 1) causes peakConcurrency > 1
    let unthrottledSeq = 0;
    const unthrottledClient = new XmsgGuardClient(
      {
        send: async () => {
          await sleep(30);
          const id = `m-${++unthrottledSeq}`;
          setTimeout(() => {
            unthrottledClient.routeReply(id, JSON.stringify({ verdict: "allow", reason: "ok", cleaned_text: "" }));
          }, 10);
          return id;
        },
      },
      { maxConcurrency: 3, timeoutMs: 1_000 },
    );
    const e: Envelope = { source: "message", history: [], content: { sender: "@u:x", tier: "public", text: "hi" } };
    await Promise.all([unthrottledClient.check(e), unthrottledClient.check(e), unthrottledClient.check(e)]);
    assert.throws(
      () => {
        assert.equal(unthrottledClient.peakConcurrency, 1, "concurrency limit must cap peakConcurrency at 1");
      },
      /AssertionError/,
      "Mutant 2 (concurrency limit removed) must fail RED with peakConcurrency > 1",
    );
  },
);

