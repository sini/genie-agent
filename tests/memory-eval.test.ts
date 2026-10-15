// Unit C2.2: Tier-1 Operating Memory (Wiki & Bank) and Recall Eval
// Gating Oracles and Hermetic Eval Suite.
// Run with: `node --test tests/memory-eval.test.ts`
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import {
  DEFAULT_HINDSIGHT_ENDPOINT,
  GENIE_BANK_ID,
  GENIE_MEMORY_BANK_ID,
  HindsightRecallClient,
  recallBankId,
} from "../src/bank/index.ts";
import {
  assertNotEmptyMemoryArm,
  formatMemoryReportTables,
  type MemoryArm,
  type MemoryRecallFixture,
  type QuestionFixture,
  runTier1MemoryEval,
  verifyModelFreeRetrieval,
} from "../src/tier1/eval.ts";
import { confine, type Host, type Pi, tier1 } from "../src/tier1/index.ts";
import { memoryPrompt, tier1Launch } from "../src/tier1/launch.ts";

const repoRoot = new URL("..", import.meta.url).pathname;
const questionsFile = `${repoRoot}/tests/fixtures/memory-eval/questions.jsonl`;
const recallFixturesFile = `${repoRoot}/tests/fixtures/memory-eval/recall-fixtures.json`;
const memoryMdPath = `${repoRoot}/operating-memory/MEMORY.md`;

const questions: QuestionFixture[] = readFileSync(questionsFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const recallFixtures: MemoryRecallFixture = JSON.parse(
  readFileSync(recallFixturesFile, "utf8"),
);

// --- Oracle 1: Confinement, Symlinks & Traversal ---
test("Oracle 1: confine enforces realpath across worktree and memory mount; refuses escapes and symlink targets outside", () => {
  const tmp = realpathSync(mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/genie-c22-confine-`));
  const worktree = `${tmp}/worktree`;
  const memory = `${tmp}/memory`;
  const outside = `${tmp}/outside`;

  mkdirSync(worktree, { recursive: true });
  mkdirSync(memory, { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(`${worktree}/file.txt`, "worktree file");
  writeFileSync(`${memory}/MEMORY.md`, "# Index");
  writeFileSync(`${memory}/rule.md`, "memory rule");
  writeFileSync(`${outside}/secret.txt`, "outside secret");

  // Plant a symlink inside memory pointing outside both roots
  symlinkSync(`${outside}/secret.txt`, `${memory}/link-to-outside`);

  // Plant a valid symlink inside memory pointing to another memory file
  symlinkSync(`${memory}/rule.md`, `${memory}/link-to-rule`);

  // 1. Reading valid worktree file succeeds
  assert.equal(confine(worktree, "file.txt", memory), `${worktree}/file.txt`);
  assert.equal(confine(worktree, `${worktree}/file.txt`, memory), `${worktree}/file.txt`);

  // 2. Reading valid memory file succeeds
  assert.equal(confine(worktree, `${memory}/rule.md`, memory), `${memory}/rule.md`);
  assert.equal(confine(worktree, `${memory}/link-to-rule`, memory), `${memory}/rule.md`);

  // 3. Symlink inside memory targeting outside is REFUSED
  assert.throws(
    () => confine(worktree, `${memory}/link-to-outside`, memory),
    /outside the thread's worktrees and memory mount/,
  );

  // 4. Dot-dot traversal from memory targeting outside is REFUSED
  assert.throws(
    () => confine(worktree, `${memory}/../outside/secret.txt`, memory),
    /outside the thread's worktrees and memory mount/,
  );

  // 5. Direct path outside both roots is REFUSED
  assert.throws(
    () => confine(worktree, `${outside}/secret.txt`, memory),
    /outside the thread's worktrees and memory mount/,
  );

  // 6. Dot-dot traversal from worktree is REFUSED
  assert.throws(
    () => confine(worktree, `${worktree}/../outside/secret.txt`, memory),
    /outside the thread's worktrees and memory mount/,
  );
});

// --- Oracle 2: Live Runner Stand-in Fixture Refusal (Amendment 6 & Item 4) ---
test("Oracle 2: live runner tier1-eval --memory-arms with stand-in fixture exits non-zero naming the refusal without reaching model", () => {
  const evalScript = `${repoRoot}/tests/tier1-eval.ts`;

  // 1. Running --memory-arms with default stand-in recall fixture fails closed before any model call
  const proc = spawnSync(
    process.execPath,
    [evalScript, "--memory-arms", "--base", "http://127.0.0.1:59999"],
    { encoding: "utf8" },
  );
  assert.notEqual(proc.status, 0, "must exit non-zero on stand-in fixture");
  assert.match(
    proc.stderr,
    /refused: cannot use stand-in recall fixture on a live run/,
    `stderr must name the refusal before contacting model: ${proc.stderr}`,
  );

  // 2. Repeatable --questions flag is supported and properly parsed
  const procQuestions = spawnSync(
    process.execPath,
    [
      evalScript,
      "--memory-arms",
      "--base",
      "http://127.0.0.1:59999",
      "--questions",
      questionsFile,
      "--questions",
      questionsFile,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(procQuestions.status, 0);
  assert.match(
    procQuestions.stderr,
    /refused: cannot use stand-in recall fixture on a live run/,
  );
});

// --- Oracle 3: Recall Selector Routing & Schema Refusal ---
test("Oracle 3: recall selector routes support to genie, memory to genie-memory, and schema refuses invalid values", async () => {
  // 1. Selector mapping helper
  assert.equal(recallBankId(undefined), GENIE_BANK_ID);
  assert.equal(recallBankId("support"), GENIE_BANK_ID);
  assert.equal(recallBankId("memory"), GENIE_MEMORY_BANK_ID);

  // 2. Recall client structural safety (Oracle 20 / H2 boundary: recall-only client has no retain)
  const memoryClient = new HindsightRecallClient(DEFAULT_HINDSIGHT_ENDPOINT, GENIE_MEMORY_BANK_ID);
  assert.equal(memoryClient.bankId, "genie-memory");
  assert.equal(typeof (memoryClient as any).retain, "undefined");
  assert.equal(typeof memoryClient.recall, "function");

  // 3. Schema validation in tier-1 tool
  const calls: Array<{ tool: string; arg: unknown }> = [];
  const tools = new Map<string, any>();
  const dummyPi: Pi = {
    registerTool: (t) => tools.set(t.name, t),
    on: () => {},
    setActiveTools: () => {},
  };
  const mockHost: Host = {
    eval: async () => ({}),
    recall: async (arg) => {
      calls.push({ tool: "recall", arg });
      return { results: [] };
    },
    escalate: async () => ({}),
    reply: async () => ({}),
    propose: async () => ({}),
    clone: async () => ({ path: "/root", rev: "x" }),
    screen: async () => ({ verdict: "allow" } as any),
  };

  tier1(
    { root: "/tmp", searxngUrl: "http://127.0.0.1:1", cluster: [] },
    { host: mockHost },
  )(dummyPi);

  const recallTool = tools.get("recall");
  assert.ok(recallTool, "recall tool must be registered");

  // Valid calls
  await recallTool.execute("1", { query: "q1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arg, "q1");

  await recallTool.execute("2", { query: "q2", bank: "support" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].arg, { query: "q2", bank: "support" });

  await recallTool.execute("3", { query: "q3", bank: "memory" });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].arg, { query: "q3", bank: "memory" });

  // Invalid bank values refused by schema
  await assert.rejects(
    () => recallTool.execute("4", { query: "q4", bank: "invalid" }),
    /invalid recall arguments: bank not in support|memory/,
  );
  await assert.rejects(
    () => recallTool.execute("5", { query: "q5", bank: 42 }),
    /invalid recall arguments/,
  );
});

// --- Oracle 4: Empty Memory Detection & Stand-in Refusal ---
test("Oracle 4: empty memory arms are refused and stand-in recall fixture is refused on live runs", () => {
  // Empty memory arm assertions
  assert.doesNotThrow(() => assertNotEmptyMemoryArm("no-memory"));
  assert.doesNotThrow(() => assertNotEmptyMemoryArm("wiki", "# Memory\n- [item](x.md)", {}));
  assert.doesNotThrow(() => assertNotEmptyMemoryArm("bank", "", { q1: {} }));
  assert.doesNotThrow(() => assertNotEmptyMemoryArm("wiki+bank", "# Memory\n- [item](x.md)", { q1: {} }));

  assert.throws(
    () => assertNotEmptyMemoryArm("wiki", "", {}),
    /empty memory arm: wiki has no memory loaded/,
  );
  assert.throws(
    () => assertNotEmptyMemoryArm("bank", "# Memory\n- [item](x.md)", {}),
    /empty memory arm: bank has no memory loaded/,
  );
  assert.throws(
    () => assertNotEmptyMemoryArm("wiki+bank", "", { q1: {} }),
    /empty memory arm: wiki\+bank has no memory loaded/,
  );
  assert.throws(
    () => assertNotEmptyMemoryArm("wiki+bank", "# Memory\n- [item](x.md)", {}),
    /empty memory arm: wiki\+bank has no memory loaded/,
  );

  // Stand-in refusal on live runs (Amendment 6)
  assert.throws(
    () =>
      verifyModelFreeRetrieval(
        questions.slice(0, 1),
        memoryMdPath,
        { metadata: { stand_in: true, bank_id: "genie-memory" }, fixtures: {} },
        { live: true },
      ),
    /refused: cannot use stand-in recall fixture on a live run/,
  );
});

// --- Retrieval Oracle: Model-Free Retrieval Check (Amendment 7 & Unit C2.2.1) ---
test("Retrieval Oracle: verifyModelFreeRetrieval validates all 24 questions, and catches planted unindexed slugs", () => {
  // All 24 questions pass verification against actual operating-memory/MEMORY.md and recall fixtures
  const result = verifyModelFreeRetrieval(questions, memoryMdPath, recallFixtures);
  assert.equal(result.verified, 24);
  assert.equal(result.unindexedSlugs.length, 0);
  assert.equal(result.missingFixtureSlugs.length, 0);
  assert.deepEqual(result.retrieval_misses, []);

  // Planted unindexed citation slug is detected and refused even when recall fixture exists (and even on a live run)
  const planted: QuestionFixture[] = [
    {
      id: "q_unindexed",
      question: "What is an unindexed policy?",
      expected_citations: ["unindexed/fabricated-policy.md"],
    },
  ];
  const fixturesWithPlanted: MemoryRecallFixture = {
    ...recallFixtures,
    metadata: { ...recallFixtures.metadata, stand_in: false },
    fixtures: {
      ...recallFixtures.fixtures,
      q_unindexed: {
        query: "What is an unindexed policy?",
        results: [{ document_id: "unindexed/fabricated-policy.md", text: "fake" }],
      },
    },
  };

  assert.throws(
    () => verifyModelFreeRetrieval(planted, memoryMdPath, fixturesWithPlanted),
    /unindexed citation slug: unindexed\/fabricated-policy\.md in question q_unindexed not linked from/,
  );
  assert.throws(
    () => verifyModelFreeRetrieval(planted, memoryMdPath, fixturesWithPlanted, { live: true }),
    /unindexed citation slug: unindexed\/fabricated-policy\.md in question q_unindexed not linked from/,
  );

  // Question with no fixture entry at all still refuses on both hermetic and live runs
  const noEntryFixtures: MemoryRecallFixture = {
    metadata: { ...recallFixtures.metadata, stand_in: false },
    fixtures: {},
  };
  assert.throws(
    () => verifyModelFreeRetrieval(questions.slice(0, 1), memoryMdPath, noEntryFixtures, { live: true }),
    /missing recall fixture for question q01/,
  );
});

test("Oracle C2.2.1: a live run with a fixture miss proceeds and reports retrieval_misses: [qid], while unindexed slugs and missing fixture entries still refuse", async () => {
  const subset = questions.slice(0, 2); // q01, q02
  const missFixtures: MemoryRecallFixture = {
    metadata: { bank_id: "genie-memory", stand_in: false },
    fixtures: {
      [subset[0].id]: {
        query: subset[0].question,
        // Recorded entry exists, but the expected citation was not returned by the bank
        results: [{ document_id: "unrelated/other.md", text: "unrelated recall result" }],
      },
      [subset[1].id]: recallFixtures.fixtures[subset[1].id],
    },
  };

  // Hermetic (non-live) still throws on a missing citation in the fixture
  assert.throws(
    () => verifyModelFreeRetrieval(subset, memoryMdPath, missFixtures, { live: false }),
    new RegExp(`expected citation .* not found in recall fixture for ${subset[0].id}`),
  );

  // Live check proceeds and reports retrieval_misses: [qid]
  const check = verifyModelFreeRetrieval(subset, memoryMdPath, missFixtures, { live: true });
  assert.equal(check.verified, 1);
  assert.deepEqual(check.retrieval_misses, [subset[0].id]);

  // Full live run proceeds, scores all questions, and reports retrieval_misses at top level and per arm
  const report = await runTier1MemoryEval({
    model: "stub-qwen",
    base: "http://127.0.0.1:1",
    memoryRoot: `${repoRoot}/operating-memory`,
    memoryMdPath,
    recallFixtures: missFixtures,
    questions: subset,
    arms: ["no-memory", "wiki", "bank", "wiki+bank"],
    runs: 1,
    concurrency: 1,
    live: true,
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const msgs = body.messages ?? [];
      const sys = msgs.find((m: any) => m.role === "system")?.content ?? "";
      const usr = msgs.find((m: any) => m.role === "user")?.content ?? "";
      const q = subset.find((item) => item.question === usr) ?? subset[0];
      const cite = q.expected_citations?.[0] ?? "";
      const claims = q.expected_claims ?? [];
      const hasWiki = sys.includes("# Operating Memory Index");
      const toolMsg = msgs.find((m: any) => m.role === "tool");

      if (msgs.length === 2) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    hasWiki
                      ? {
                          id: "c1",
                          type: "function",
                          function: {
                            name: "read",
                            arguments: JSON.stringify({ path: `${repoRoot}/operating-memory/${cite}` }),
                          },
                        }
                      : {
                          id: "c1",
                          type: "function",
                          function: {
                            name: "recall",
                            arguments: JSON.stringify({ query: q.question, bank: "memory" }),
                          },
                        },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      const got = (toolMsg?.content ?? "").includes(cite) || (toolMsg?.content ?? "").includes("---");
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c2",
                    type: "function",
                    function: {
                      name: "reply",
                      arguments: JSON.stringify({
                        answer: got ? `Per ${cite}: ${claims.join(" ")}` : "Unknown",
                        confidence: got ? 0.9 : 0.5,
                        gaps: [],
                        escalate_forced: "no",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.deepEqual(report.retrieval_misses, [subset[0].id]);
  assert.deepEqual(report.model_free_retrieval?.retrieval_misses, [subset[0].id]);
  // Both questions are still scored in every arm
  assert.equal(report.arms["bank"].runs[0].questions.length, 2);
  // Bank arm missed q01 and retrieved q02
  assert.deepEqual(report.arms["bank"].retrieval_misses, [subset[0].id]);
  assert.equal(report.arms["bank"].retrieval_miss_count, 1);
  // Wiki arm retrieved both via read
  assert.deepEqual(report.arms["wiki"].retrieval_misses, []);
  assert.equal(report.arms["wiki"].retrieval_miss_count, 0);

  const tables = formatMemoryReportTables(report);
  assert.match(tables, new RegExp(`retrieval_misses: \\["${subset[0].id}"\\]`));
});

// --- System Prompt & Launch Integration (Amendment 2) ---
test("Amendment 2: memoryPrompt refuses missing index without silent fallback, and tier1Launch seeds conditionally", () => {
  // Existing memory index loads properly
  const prompt = memoryPrompt(memoryMdPath);
  assert.ok(prompt.startsWith("# Operating Memory Index\n\n"));
  assert.ok(prompt.includes("workflow/orchestrator-operating-rules.md"));

  // Non-existent path throws naming the missing path
  assert.throws(
    () => memoryPrompt("/nonexistent/MEMORY.md"),
    /memory index not found: \/nonexistent\/MEMORY.md/,
  );

  // tier1Launch without memory: no memory prompt in args
  const noMemLaunch = tier1Launch({
    pi: "pi",
    config: () => ({ root: "/tmp", searxngUrl: "http://127.0.0.1:1", cluster: [] }),
    memory: false,
  });
  const noMemArgs = noMemLaunch("t1").args;
  assert.ok(!noMemArgs.some((a) => a.includes("# Operating Memory Index")));

  // tier1Launch with memory: memory prompt present
  const memLaunch = tier1Launch({
    pi: "pi",
    config: () => ({ root: "/tmp", searxngUrl: "http://127.0.0.1:1", cluster: [] }),
    memory: true,
    memoryPath: memoryMdPath,
  });
  const memArgs = memLaunch("t1").args;
  assert.ok(memArgs.some((a) => a.includes("# Operating Memory Index")));
});

// --- Hermetic Memory Eval Runner (4 Arms Discrimination & Noise Band) ---
test("Hermetic Memory Eval: each memory arm beats no-memory across repeated runs", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let callCount = 0;

  const server: Server = createServer((req, res) => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;

    if (req.method === "POST" && req.url === "/chat/completions") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        callCount++;
        const parsed = JSON.parse(body);
        const messages = parsed.messages ?? [];
        const systemMsg = messages.find((m: any) => m.role === "system")?.content ?? "";
        const userMsg = messages.find((m: any) => m.role === "user")?.content ?? "";
        const lastMsg = messages[messages.length - 1];

        const hasWiki = systemMsg.includes("# Operating Memory Index");

        // Identify which question
        const q = questions.find((item) => item.question === userMsg) ?? questions[0];
        const cite = q.expected_citations?.[0] ?? "";
        const claims = q.expected_claims ?? [];

        // Check if previous turn had tool call
        const toolResultMsg = messages.find((m: any) => m.role === "tool");
        let toolData = "";
        if (toolResultMsg) {
          toolData = toolResultMsg.content;
        }

        // First turn: if wiki or bank available, model calls tool
        if (messages.length === 2) {
          if (hasWiki) {
            // Wiki arm calls read
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "tool_calls",
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call_read_1",
                          type: "function",
                          function: {
                            name: "read",
                            arguments: JSON.stringify({ path: `${repoRoot}/operating-memory/${cite}` }),
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            inFlight--;
            return;
          } else {
            // Check if recall can be called
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "tool_calls",
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call_recall_1",
                          type: "function",
                          function: {
                            name: "recall",
                            arguments: JSON.stringify({ query: q.question, bank: "memory" }),
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            inFlight--;
            return;
          }
        }

        // Final turn: reply with answers based on available memory
        const gotMemory =
          toolData.includes(cite) ||
          toolData.includes("Operating memory excerpt") ||
          toolData.includes("Rule:") ||
          (toolData.includes("---") && toolData.includes("description:"));

        let answer = "";
        let confidence = 0.5;

        if (gotMemory) {
          // Memory arm with successful retrieval
          const jitter = (callCount % 2) * 0.02;
          confidence = Number((0.92 - jitter).toFixed(2));
          answer = `Based on ${cite}, we must apply ${claims.join(" and ")}.`;
        } else {
          // No-memory arm: generic answer without claims or citations
          confidence = 0.6;
          answer = "I don't have access to the operating rules for this case.";
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_reply_1",
                      type: "function",
                      function: {
                        name: "reply",
                        arguments: JSON.stringify({
                          answer,
                          confidence,
                          gaps: gotMemory ? [] : ["missing memory context"],
                          escalate_forced: "no",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
        inFlight--;
      });
      return;
    }

    res.writeHead(404);
    res.end();
    inFlight--;
  });

  let port = 0;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });

  try {
    const report = await runTier1MemoryEval({
      model: "stub-qwen",
      base: `http://127.0.0.1:${port}`,
      memoryRoot: `${repoRoot}/operating-memory`,
      memoryMdPath,
      recallFixtures,
      questions: questions.slice(0, 4), // 4 questions across arms
      arms: ["no-memory", "wiki", "bank", "wiki+bank"],
      runs: 2,
      concurrency: 1,
    });

    // Concurrency cap verified
    assert.strictEqual(maxInFlight, 1, `concurrency must be 1 (got ${maxInFlight})`);

    // Retrieval rate checks
    assert.equal(report.arms["no-memory"].retrieval_rate, 0, "no-memory arm must have 0 retrieval");
    assert.equal(report.arms["wiki"].retrieval_rate, 1, "wiki arm must retrieve 100%");
    assert.equal(report.arms["bank"].retrieval_rate, 1, "bank arm must retrieve 100%");
    assert.equal(report.arms["wiki+bank"].retrieval_rate, 1, "wiki+bank arm must retrieve 100%");

    // Use checks: each memory arm scores higher than no-memory
    const noMemScore = report.arms["no-memory"].mean_score;
    assert.ok(report.arms["wiki"].mean_score > noMemScore, "wiki must beat no-memory");
    assert.ok(report.arms["bank"].mean_score > noMemScore, "bank must beat no-memory");
    assert.ok(report.arms["wiki+bank"].mean_score > noMemScore, "wiki+bank must beat no-memory");

    // Comparisons against baseline (no-memory)
    assert.equal(report.comparisons.length, 3);
    for (const comp of report.comparisons) {
      assert.ok(comp.delta > 0, `${comp.baseline_arm} delta must be positive`);
      assert.equal(comp.status, "discriminating");
    }

    // Report table output
    const tables = formatMemoryReportTables(report);
    assert.ok(tables.includes("Tier-1 Operating Memory Eval Summary"));
    assert.ok(tables.includes("wiki+bank"));
    assert.ok(tables.includes("discriminating"));
  } finally {
    server.close();
  }
});
