// The genie hindsight bank unit tests and gating oracle (plan H1, design row 8, §6).
// Oracle: recall from it returns its seed entry and nothing from den-law; positive control: the same query on den-law hits.
// Run with `node --test tests/bank.test.ts`.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import {
  DEFAULT_HINDSIGHT_ENDPOINT,
  DEN_LAW_BANK_ID,
  GENIE_BANK_CONFIG,
  GENIE_BANK_ID,
  HindsightBankClient,
  verifyBankIsolation,
} from "../src/bank/index.ts";

// Stub hindsight HTTP server for hermetic CI testing
async function stubHindsight(handlers?: {
  onRecall?: (bankId: string, query: string) => unknown;
  onRetain?: (bankId: string, items: unknown[]) => unknown;
  onConfig?: (bankId: string) => unknown;
}) {
  const requests: { method: string; url: string; body: string }[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      const u = new URL(req.url ?? "", "http://localhost");

      if (u.pathname.endsWith("/config")) {
        const parts = u.pathname.split("/");
        const bank = parts[parts.indexOf("banks") + 1];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(handlers?.onConfig?.(bank) ?? { bank_id: bank, overrides: GENIE_BANK_CONFIG }));
        return;
      }

      if (u.pathname.endsWith("/memories/recall") && req.method === "POST") {
        const parts = u.pathname.split("/");
        const bank = parts[parts.indexOf("banks") + 1];
        const parsed = JSON.parse(body || "{}");
        const resp = handlers?.onRecall?.(bank, parsed.query) ?? {
          results: bank === "genie"
            ? [{ id: "seed-1", text: "seed text", type: "world", document_id: "eval-never-build", tags: ["tier:support"] }]
            : [{ id: "den-1", text: "standing law", type: "world", document_id: "adr-0021", tags: ["tier:law"] }],
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
        return;
      }

      if (u.pathname.endsWith("/memories") && req.method === "POST") {
        const parts = u.pathname.split("/");
        const bank = parts[parts.indexOf("banks") + 1];
        const parsed = JSON.parse(body || "{}");
        const resp = handlers?.onRetain?.(bank, parsed.items) ?? { success: true, bank_id: bank, items_count: 1 };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
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
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("HindsightBankClient: recall and retain serialization over HTTP", async () => {
  const stub = await stubHindsight();
  try {
    const client = new HindsightBankClient(stub.endpoint, "genie");
    const rec = await client.recall({ query: "pure eval limits" });
    assert.equal(rec.results.length, 1);
    assert.equal(rec.results[0].document_id, "eval-never-build");

    const ret = await client.retain({
      items: [{ content: "sample content", document_id: "test-doc" }],
    });
    assert.equal(ret.success, true);
    assert.equal(ret.bank_id, "genie");
  } finally {
    await stub.close();
  }
});

test("oracle H1: bank isolation verification succeeds with seed entry and isolated banks", async () => {
  const stub = await stubHindsight();
  try {
    const genie = new HindsightBankClient(stub.endpoint, "genie");
    const denLaw = new HindsightBankClient(stub.endpoint, "den-law");

    const res = await verifyBankIsolation(genie, denLaw, "pure eval", "eval-never-build");
    assert.equal(res.seedFound, true);
    assert.equal(res.seedDocumentId, "eval-never-build");
    assert.equal(res.denLawHitsInGenie, 0);
    assert.equal(res.positiveControlHits, 1);
    assert.equal(res.positiveControlSeedFoundInDenLaw, false);
  } finally {
    await stub.close();
  }
});

test("mutant 1: target bank leaking den-law entries triggers RED", async () => {
  const stub = await stubHindsight({
    onRecall: (bank) => {
      if (bank === "genie") {
        return {
          results: [
            { id: "seed-1", text: "seed text", type: "world", document_id: "eval-never-build", tags: ["tier:support"] },
            { id: "leak-1", text: "RULE — leaked law", type: "world", document_id: "law-entry", tags: ["tier:law"] },
          ],
        };
      }
      return { results: [{ id: "den-1", text: "law", type: "world", document_id: "law-entry", tags: ["tier:law"] }] };
    },
  });
  try {
    const genie = new HindsightBankClient(stub.endpoint, "genie");
    const denLaw = new HindsightBankClient(stub.endpoint, "den-law");

    await assert.rejects(
      () => verifyBankIsolation(genie, denLaw, "pure eval", "eval-never-build"),
      /leaked 1 entry\(ies\) from den-law/,
    );
  } finally {
    await stub.close();
  }
});

test("mutant 2: seed entry absent from target bank triggers RED", async () => {
  const stub = await stubHindsight({
    onRecall: (bank) => {
      if (bank === "genie") {
        return { results: [] };
      }
      return { results: [{ id: "den-1", text: "law", type: "world", document_id: "law-entry", tags: ["tier:law"] }] };
    },
  });
  try {
    const genie = new HindsightBankClient(stub.endpoint, "genie");
    const denLaw = new HindsightBankClient(stub.endpoint, "den-law");

    await assert.rejects(
      () => verifyBankIsolation(genie, denLaw, "pure eval", "eval-never-build"),
      /seed entry eval-never-build not returned/,
    );
  } finally {
    await stub.close();
  }
});

test("mutant 3: positive control with 0 hits on den-law triggers RED", async () => {
  const stub = await stubHindsight({
    onRecall: (bank) => {
      if (bank === "genie") {
        return {
          results: [{ id: "seed-1", text: "seed text", type: "world", document_id: "eval-never-build", tags: ["tier:support"] }],
        };
      }
      return { results: [] };
    },
  });
  try {
    const genie = new HindsightBankClient(stub.endpoint, "genie");
    const denLaw = new HindsightBankClient(stub.endpoint, "den-law");

    await assert.rejects(
      () => verifyBankIsolation(genie, denLaw, "pure eval", "eval-never-build"),
      /Positive control failure: query 'pure eval' returned 0 hits on den-law/,
    );
  } finally {
    await stub.close();
  }
});

test("mutant 4: cross-contamination of seed entry in den-law triggers RED", async () => {
  const stub = await stubHindsight({
    onRecall: (bank) => {
      if (bank === "genie") {
        return {
          results: [{ id: "seed-1", text: "seed text", type: "world", document_id: "eval-never-build", tags: ["tier:support"] }],
        };
      }
      return {
        results: [
          { id: "den-1", text: "law", type: "world", document_id: "eval-never-build", tags: ["tier:law"] },
        ],
      };
    },
  });
  try {
    const genie = new HindsightBankClient(stub.endpoint, "genie");
    const denLaw = new HindsightBankClient(stub.endpoint, "den-law");

    await assert.rejects(
      () => verifyBankIsolation(genie, denLaw, "pure eval", "eval-never-build"),
      /Cross-contamination: seed entry eval-never-build unexpectedly found in den-law/,
    );
  } finally {
    await stub.close();
  }
});

// Live Oracle against the actual hindsight cluster endpoint if available
test("live gating oracle H1: recall from genie returns seed entry and 0 from den-law, positive control hits den-law", async () => {
  // In a hermetic Nix sandbox without network, skip the live arm immediately
  if (process.env.NIX_BUILD_TOP) {
    return;
  }

  const liveEndpoint = DEFAULT_HINDSIGHT_ENDPOINT;
  let reachable = false;
  try {
    const ping = await fetch(`${liveEndpoint}/health`, { signal: AbortSignal.timeout(2000) });
    reachable = ping.ok;
  } catch {
    reachable = false;
  }

  if (!reachable) {
    console.log("Hindsight cluster endpoint unreachable; skipping live arm (hermetic stub tests passed)");
    return;
  }

  const genie = new HindsightBankClient(liveEndpoint, GENIE_BANK_ID);
  const denLaw = new HindsightBankClient(liveEndpoint, DEN_LAW_BANK_ID);

  // Verify bank config
  const cfg = await genie.getConfig();
  assert.equal(cfg.bank_id, "genie");
  assert.equal(cfg.overrides.retain_extraction_mode, "verbatim");

  // Arm 1: eval-never-build
  const res1 = await verifyBankIsolation(
    genie,
    denLaw,
    "genie evaluates a configuration in a sandbox and never builds it",
    "eval-never-build",
  );
  assert.equal(res1.seedFound, true);
  assert.equal(res1.seedDocumentId, "eval-never-build");
  assert.equal(res1.denLawHitsInGenie, 0);
  assert.ok(res1.positiveControlHits > 0, `den-law positive control hits: ${res1.positiveControlHits}`);

  // Arm 2: den-docs
  const res2 = await verifyBankIsolation(
    genie,
    denLaw,
    "den documentation and runnable templates",
    "den-docs",
  );
  assert.equal(res2.seedFound, true);
  assert.equal(res2.seedDocumentId, "den-docs");
  assert.equal(res2.denLawHitsInGenie, 0);
  assert.ok(res2.positiveControlHits > 0, `den-law positive control hits: ${res2.positiveControlHits}`);
});
