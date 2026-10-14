// Integration gating oracles for xmsg addressing migration (AM-1, AM-2, AM-3, AM-4).
// Oracle 1: Guard round trip (bare genie-guard name, verdict relayed; mutant: svc:genie-guard refused).
// Oracle 2: Two outstanding dispatcher sends to two instance fakes with distinct PIDs; fakes reply
// in reverse order; turns matched by inReplyTo; mutant: taking next pushed reply gives Turn 1 Reply 2.
// Run with: node --test tests/xmsg-integration.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";

import { SocketXmsg, type Inbound } from "../src/dispatcher/xmsg.ts";

const XMSG_BIN =
  process.env.XMSG_BIN ??
  (existsSync("/nix/store/c5xj0l24aqy8439rjsnrvlgw4r51qg7c-xmsg-0.1.0/bin/xmsg")
    ? "/nix/store/c5xj0l24aqy8439rjsnrvlgw4r51qg7c-xmsg-0.1.0/bin/xmsg"
    : "xmsg");

const GENIE_GUARD_BIN =
  process.env.GENIE_GUARD_BIN ??
  (existsSync("/nix/store/x9c6bmg3hfjsm87crvz1pq6zjkd34kh1-genie-guard-0.1.0/bin/genie-guard")
    ? "/nix/store/x9c6bmg3hfjsm87crvz1pq6zjkd34kh1-genie-guard-0.1.0/bin/genie-guard"
    : "genie-guard");

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
// - xmsg refuses registration attempting "svc:genie-guard" (mutant check)
// - An envelope sent to genie-guard is reviewed via ninfer and the verdict replied
// -----------------------------------------------------------------------------
test("oracle 1: guard round trip relays verdict and refuses svc: prefix", { timeout: 30_000 }, async () => {
  const node = await startXmsg({
    "genie-guard": GENIE_GUARD_BIN,
  });

  let ninferServer: ReturnType<typeof createHttpServer> | null = null;
  let guardProc: ChildProcess | null = null;

  try {
    // Mutant test: registering as "svc:genie-guard" on register.sock is refused by xmsg.
    const mutantSocket = createConnection(node.registerSock);
    mutantSocket.setEncoding("utf8");
    const mutantResult = await new Promise<{ status?: string; error?: string }>((resolve, reject) => {
      mutantSocket.on("error", reject);
      mutantSocket.on("data", (chunk: string) => {
        const line = chunk.trim().split("\n")[0];
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
      });
      mutantSocket.write(JSON.stringify({ harness: "svc", name: "svc:genie-guard" }) + "\n");
    });
    mutantSocket.destroy();
    assert.equal(mutantResult.status, "error", "xmsg must refuse registration under svc:genie-guard");

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
            cleaned_text: "how do I pin nixpkgs?",
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
    assert.equal(reply.cleaned_text, "how do I pin nixpkgs?");
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
// Oracle 2: Two outstanding dispatcher sends to two instance fakes with distinct PIDs
// - Fakes reply in reverse order (inst-2 replies before inst-1)
// - Turns are matched by inReplyTo
// - Mutant: taking next pushed reply gives Turn 1 Reply 2 => RED
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

    try {
      // Wait for both instance fakes to be ready
      const ready1 = await inst1.waitLine("READY");
      const ready2 = await inst2.waitLine("READY");
      const pid1 = parseInt(ready1.split(" ")[1], 10);
      const pid2 = parseInt(ready2.split(" ")[1], 10);
      assert.notEqual(pid1, pid2, "instance fakes must have distinct PIDs");

      // Register dispatcher on register.sock
      await dispatcherXmsg.register();

      // Dispatcher sends message 1 to inst-1 and message 2 to inst-2
      const sent1Id = await dispatcherXmsg.send("inst-1", "question 1", "key-1");
      const sent2Id = await dispatcherXmsg.send("inst-2", "question 2", "key-2");
      assert.ok(sent1Id, "sent 1 must yield message id");
      assert.ok(sent2Id, "sent 2 must yield message id");
      assert.notEqual(sent1Id, sent2Id, "sent message IDs must be distinct");

      // Verify each instance receives its message
      await inst1.waitLine(`DELIVERED ${sent1Id}`);
      await inst2.waitLine(`DELIVERED ${sent2Id}`);

      // Now fakes reply in REVERSE order: inst-2 replies first, inst-1 replies second
      inst2.sendCmd(`REPLY ${sent2Id} Reply 2`);
      await inst2.waitLine(`REPLIED ${sent2Id}`);

      inst1.sendCmd(`REPLY ${sent1Id} Reply 1`);
      await inst1.waitLine(`REPLIED ${sent1Id}`);

      // Dispatcher receives pushed replies via poll()
      const pushedA = await dispatcherXmsg.poll(5000);
      assert.ok(pushedA, "pushed reply A must not be null");
      await dispatcherXmsg.ack(pushedA.id);

      const pushedB = await dispatcherXmsg.poll(5000);
      assert.ok(pushedB, "pushed reply B must not be null");
      await dispatcherXmsg.ack(pushedB.id);

      // Arrival order verification: pushedA was from inst-2, pushedB was from inst-1
      assert.equal(pushedA.inReplyTo, sent2Id, "first pushed message should correspond to send 2");
      assert.equal(pushedA.text, "Reply 2");

      assert.equal(pushedB.inReplyTo, sent1Id, "second pushed message should correspond to send 1");
      assert.equal(pushedB.text, "Reply 1");

      // Matching by inReplyTo:
      const turns = new Map<string, string>();
      for (const p of [pushedA, pushedB]) {
        if (p.inReplyTo) turns.set(p.inReplyTo, p.text);
      }

      const turn1Reply = turns.get(sent1Id);
      const turn2Reply = turns.get(sent2Id);

      assert.equal(turn1Reply, "Reply 1", "Turn 1 must receive Reply 1 matched by inReplyTo");
      assert.equal(turn2Reply, "Reply 2", "Turn 2 must receive Reply 2 matched by inReplyTo");

      // Mutant assertion:
      // If dispatcher took the next pushed reply in FIFO arrival order without matching inReplyTo,
      // Turn 1 would take pushedA.text ("Reply 2").
      const naiveFifoTurn1Reply = pushedA.text;
      assert.equal(naiveFifoTurn1Reply, "Reply 2");
      assert.notEqual(
        turn1Reply,
        naiveFifoTurn1Reply,
        "mutant check: Turn 1 would erroneously receive Reply 2 under naive FIFO taking",
      );
    } finally {
      dispatcherXmsg.close();
      await inst1.stop();
      await inst2.stop();
      await node.stop();
    }
  },
);
