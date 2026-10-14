// Distiller prompt, persistent review queue, and separate approval CLI test suite (Unit H2, Oracle 20).
//
// Invariants tested by construction across processes (Oracle 20):
// 1. The genie root's bank client has NO retain (recall-only).
// 2. A candidate enqueued by one process (Distiller) is stored on disk and approved by
//    the separate review CLI executable (genie-bank-review) spawned as another process.
// 3. accept => queue grows by 1 on disk, bank grows by 0.
// 4. approve => bank grows by 1.
// 5. With no approval, the bank stays at 0.
// 6. Deterministic checks run again at approve time and may still refuse.
// 7. Stub bank only, zero live service calls.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  type CandidateInput,
  Distiller,
  HindsightRecallClient,
  HindsightWriteClient,
  ReviewQueue,
} from "../src/bank/index.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("bin/genie-bank-review.ts");
const SECRET_WRITE_TOKEN = "secret-owner-bank-token-987";

// Stub hindsight HTTP server with optional Bearer token enforcement on /memories retain
async function stubHindsightBank(requiredWriteToken?: string) {
  const retainedItems: { bank: string; item: any }[] = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const u = new URL(req.url ?? "", "http://localhost");

      if (u.pathname.endsWith("/memories") && req.method === "POST") {
        if (requiredWriteToken) {
          const auth = req.headers.authorization;
          if (auth !== `Bearer ${requiredWriteToken}`) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized: valid write token required" }));
            return;
          }
        }

        const parts = u.pathname.split("/");
        const bank = parts[parts.indexOf("banks") + 1];
        const parsed = JSON.parse(body || "{}");
        for (const item of parsed.items ?? []) {
          retainedItems.push({ bank, item });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, bank_id: bank, items_count: (parsed.items ?? []).length }));
        return;
      }

      if (u.pathname.endsWith("/memories/recall") && req.method === "POST") {
        const parts = u.pathname.split("/");
        const bank = parts[parts.indexOf("banks") + 1];
        const parsed = JSON.parse(body || "{}");
        const hits = retainedItems
          .filter((r) => r.bank === bank && (r.item.content?.includes(parsed.query) || r.item.document_id === parsed.query))
          .map((r, i) => ({
            id: `hit-${i}`,
            text: r.item.content,
            type: "world",
            document_id: r.item.document_id,
            tags: r.item.tags,
          }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: hits }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    retainedItems,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeTempQueueDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "genie-review-queue-"));
}

test("Oracle 20 cell 1: the genie root's bank client has no retain (recall-only)", () => {
  const rootClient = new HindsightRecallClient("http://127.0.0.1:8888", "genie");

  // Structural assertion: retain method is completely absent from the recall-only client
  assert.equal(typeof (rootClient as any).retain, "undefined");
  assert.equal(typeof (HindsightRecallClient.prototype as any).retain, "undefined");

  // Recall exists and is a function
  assert.equal(typeof rootClient.recall, "function");
});

test("Oracle 20 cell 2: accept => queue grows by 1 on disk and bank by 0", async () => {
  const stub = await stubHindsightBank(SECRET_WRITE_TOKEN);
  const queueDir = makeTempQueueDir();
  try {
    const queue = new ReviewQueue(queueDir);
    const rootRecallClient = new HindsightRecallClient(stub.endpoint, "genie");
    const distiller = new Distiller(queue, rootRecallClient);

    assert.equal(queue.size(), 0);
    assert.equal(stub.retainedItems.length, 0);

    const result = distiller.acceptResolution({
      threadId: "thread-101",
      userQuestion: "How do I evaluate a flake attribute without building in den?",
      diagnosticSteps: [
        "check nix flake show output",
        "verify --no-build flag behavior in den eval",
      ],
      acceptedSolution: "Use `den eval --no-build <flake>#<attr>` to inspect derivation attributes without building.",
      documentIdSlug: "den-eval-no-build",
      tags: ["tier:support", "den", "eval"],
    });

    assert.equal(result.admittedToQueue, true);
    assert.equal(result.candidate.status, "pending");

    // QUEUE GROWS BY 1 on disk
    assert.equal(queue.size("pending"), 1);
    const pendingFile = path.join(queueDir, "pending", `${result.candidate.id}.json`);
    assert.ok(fs.existsSync(pendingFile), "Candidate file must exist on disk");

    // BANK GROWS BY 0 (nothing written to the bank on accept)
    assert.equal(stub.retainedItems.length, 0);
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    await stub.close();
  }
});

test("Oracle 20 cell 3: candidate enqueued by genie process is approved by separate CLI process, and bank grows by 1", async () => {
  const stub = await stubHindsightBank(SECRET_WRITE_TOKEN);
  const queueDir = makeTempQueueDir();
  try {
    const queue = new ReviewQueue(queueDir);
    const rootRecallClient = new HindsightRecallClient(stub.endpoint, "genie");
    const distiller = new Distiller(queue, rootRecallClient);

    // Process 1 (Genie agent): enqueues candidate to disk
    const result = distiller.acceptResolution({
      threadId: "thread-102",
      userQuestion: "How to resolve infinite recursion in NixOS module options?",
      diagnosticSteps: ["inspect eval stack trace", "locate circular config reference"],
      acceptedSolution: "Break the cycle using `lib.mkIf` or define the default in a separate submodule.",
      documentIdSlug: "nixos-module-infinite-recursion",
      tags: ["tier:support", "nixos"],
    });

    const candidateId = result.candidate.id;
    assert.equal(stub.retainedItems.length, 0);
    assert.ok(fs.existsSync(path.join(queueDir, "pending", `${candidateId}.json`)));

    // Process 2 (Owner): runs separate review CLI executable with write token
    const { stdout } = await execFileAsync("node", [
      CLI_PATH,
      "approve",
      candidateId,
      "--queue-dir",
      queueDir,
      "--endpoint",
      stub.endpoint,
      "--write-token",
      SECRET_WRITE_TOKEN,
    ]);

    assert.ok(stdout.includes(`Approved candidate ${candidateId}`));

    // File on disk moved from pending/ to approved/
    assert.ok(!fs.existsSync(path.join(queueDir, "pending", `${candidateId}.json`)));
    assert.ok(fs.existsSync(path.join(queueDir, "approved", `${candidateId}.json`)));

    // BANK GROWS BY 1
    assert.equal(stub.retainedItems.length, 1);
    assert.equal(stub.retainedItems[0].bank, "genie");
    assert.equal(stub.retainedItems[0].item.document_id, "nixos-module-infinite-recursion");
    assert.ok(stub.retainedItems[0].item.content.includes("Break the cycle"));
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    await stub.close();
  }
});

test("Oracle 20 cell 4: check-passing entry with no approval stays out of the bank", async () => {
  const stub = await stubHindsightBank(SECRET_WRITE_TOKEN);
  const queueDir = makeTempQueueDir();
  try {
    const queue = new ReviewQueue(queueDir);
    const rootRecallClient = new HindsightRecallClient(stub.endpoint, "genie");
    const distiller = new Distiller(queue, rootRecallClient);

    const result = distiller.acceptResolution({
      threadId: "thread-103",
      userQuestion: "Nix flakes lock file pure evaluation constraints",
      diagnosticSteps: ["inspected flake.lock"],
      acceptedSolution: "Pure evaluation prohibits network access during evaluation.",
      documentIdSlug: "flake-lock-pure-eval",
      tags: ["tier:support", "nix"],
    });

    assert.equal(result.admittedToQueue, true);
    assert.equal(result.candidate.status, "pending");

    // No approval CLI command run. Query recall from bank:
    const recall = await rootRecallClient.recall({ query: "flake-lock-pure-eval" });
    assert.equal(recall.results.length, 0, "Unapproved entry must NOT be retrievable from the bank");
    assert.equal(stub.retainedItems.length, 0, "Bank fact count must remain 0");
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    await stub.close();
  }
});

test("Oracle 20 cell 5: deterministic checks run again at approve time and may still refuse", async () => {
  const stub = await stubHindsightBank(SECRET_WRITE_TOKEN);
  const queueDir = makeTempQueueDir();
  try {
    const queue = new ReviewQueue(queueDir);
    const rootRecallClient = new HindsightRecallClient(stub.endpoint, "genie");
    const distiller = new Distiller(queue, rootRecallClient);

    const result = distiller.acceptResolution({
      threadId: "thread-104",
      userQuestion: "Git authentication setup in devShell",
      diagnosticSteps: ["check git credential helper"],
      acceptedSolution: "Configure git credential helper cache.",
      documentIdSlug: "git-auth-cache",
      tags: ["tier:support"],
    });

    const candidateId = result.candidate.id;
    const pendingFile = path.join(queueDir, "pending", `${candidateId}.json`);
    assert.ok(fs.existsSync(pendingFile));

    // Tamper with the candidate file on disk to plant a credential shape before approval
    const contentOnDisk = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
    contentOnDisk.solution = "Use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    contentOnDisk.content += "\nUse token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    fs.writeFileSync(pendingFile, JSON.stringify(contentOnDisk, null, 2), "utf8");

    // Process 2 (Owner review CLI) attempts to approve the tampered candidate:
    // MUST FAIL with non-zero exit code because deterministic checks re-run at approve time
    await assert.rejects(
      () =>
        execFileAsync("node", [
          CLI_PATH,
          "approve",
          candidateId,
          "--queue-dir",
          queueDir,
          "--endpoint",
          stub.endpoint,
          "--write-token",
          SECRET_WRITE_TOKEN,
        ]),
      (err: any) => {
        assert.ok(err.stderr.includes("Approve-time check refused"));
        assert.ok(err.stderr.includes("credential shape detected"));
        return true;
      },
    );

    // Bank remains completely empty
    assert.equal(stub.retainedItems.length, 0);
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    await stub.close();
  }
});

test("Oracle 20 cell 6: review CLI without valid write token fails and bank stays empty", async () => {
  const stub = await stubHindsightBank(SECRET_WRITE_TOKEN);
  const queueDir = makeTempQueueDir();
  try {
    const queue = new ReviewQueue(queueDir);
    const rootRecallClient = new HindsightRecallClient(stub.endpoint, "genie");
    const distiller = new Distiller(queue, rootRecallClient);

    const result = distiller.acceptResolution({
      threadId: "thread-105",
      userQuestion: "Nix store path info query",
      diagnosticSteps: ["run nix path-info"],
      acceptedSolution: "Run nix path-info to inspect closure size.",
      documentIdSlug: "nix-path-info",
      tags: ["tier:support"],
    });

    const candidateId = result.candidate.id;

    // Run review CLI with wrong token:
    await assert.rejects(
      () =>
        execFileAsync("node", [
          CLI_PATH,
          "approve",
          candidateId,
          "--queue-dir",
          queueDir,
          "--endpoint",
          stub.endpoint,
          "--write-token",
          "wrong-unauthorized-token",
        ]),
      (err: any) => {
        assert.ok(err.stderr.includes("Approval failed"));
        return true;
      },
    );

    // Bank untouched
    assert.equal(stub.retainedItems.length, 0);
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
    await stub.close();
  }
});

test("Oracle 20 cell 7: deterministic checks refuse credentials and planted markers on enqueue", () => {
  const queueDir = makeTempQueueDir();
  try {
    const queue = new ReviewQueue(queueDir);

    // Planted credential
    const res1 = queue.enqueue({
      threadId: "leak-1",
      documentId: "leaked-token",
      title: "Valid title here",
      problem: "Valid problem description",
      solution: "Export token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      diagnosticSteps: ["step 1"],
      tags: ["tier:support"],
    });
    assert.equal(res1.admittedToQueue, false);
    assert.equal(res1.candidate.status, "refused");
    assert.ok(fs.existsSync(path.join(queueDir, "refused", `${res1.candidate.id}.json`)));
    assert.ok(!fs.existsSync(path.join(queueDir, "pending", `${res1.candidate.id}.json`)));

    // Planted private memory marker
    const res2 = queue.enqueue({
      threadId: "leak-2",
      documentId: "planted-marker",
      title: "Standing law and guidelines",
      problem: "How does fleet memory operate?",
      solution: "Contains PRIVATE_MEMORY_MARKER in the text.",
      diagnosticSteps: ["read memory"],
      tags: ["tier:support"],
    });
    assert.equal(res2.admittedToQueue, false);
    assert.equal(res2.candidate.status, "refused");
  } finally {
    fs.rmSync(queueDir, { recursive: true, force: true });
  }
});
