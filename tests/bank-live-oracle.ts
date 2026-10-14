// Opt-in Live Hindsight Gating Oracle for Unit H1.
// Connects to the live hindsight cluster endpoint at 10.11.0.20:8888.
// FAILS immediately if unreachable or if any isolation oracle condition fails.
// Live recall against the shared service is the owner's acceptance check.
import assert from "node:assert/strict";
import {
  DEFAULT_HINDSIGHT_ENDPOINT,
  DEN_LAW_BANK_ID,
  GENIE_BANK_ID,
  HindsightBankClient,
  verifyBankIsolation,
} from "../src/bank/index.ts";

async function main() {
  const endpoint = process.env.HINDSIGHT_ENDPOINT ?? DEFAULT_HINDSIGHT_ENDPOINT;
  console.log(`Running live gating oracle against: ${endpoint}`);

  // Health check: MUST NOT skip silently. Fail hard if unreachable.
  let ping: Response;
  try {
    ping = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    console.error(`FATAL: Hindsight endpoint ${endpoint} unreachable:`, err);
    process.exit(1);
  }

  if (!ping.ok) {
    console.error(`FATAL: Hindsight endpoint health check failed with status ${ping.status}`);
    process.exit(1);
  }

  const genie = new HindsightBankClient(endpoint, GENIE_BANK_ID);
  const denLaw = new HindsightBankClient(endpoint, DEN_LAW_BANK_ID);

  console.log("Checking genie bank configuration...");
  const cfg = await genie.getConfig();
  assert.equal(cfg.bank_id, "genie", "Bank ID must be 'genie'");
  assert.equal(
    cfg.overrides.retain_extraction_mode,
    "verbatim",
    "retain_extraction_mode must be 'verbatim'",
  );
  console.log("✔ Bank config verified:", {
    bank_id: cfg.bank_id,
    mode: cfg.overrides.retain_extraction_mode,
  });

  console.log("Running Arm 1 (eval-never-build)...");
  const res1 = await verifyBankIsolation(
    genie,
    denLaw,
    "genie evaluates a configuration in a sandbox and never builds it",
    "eval-never-build",
  );
  assert.equal(res1.seedFound, true, "Seed entry 'eval-never-build' must be found");
  assert.equal(res1.seedDocumentId, "eval-never-build");
  assert.equal(res1.denLawHitsInGenie, 0, "No den-law entries may leak into genie recall");
  assert.ok(
    res1.positiveControlHits > 0,
    `Positive control on den-law must hit (>0, got ${res1.positiveControlHits})`,
  );
  console.log("✔ Arm 1 passed:", {
    genieHits: res1.genieHits,
    seedDoc: res1.seedDocumentId,
    leakedFromDenLaw: res1.denLawHitsInGenie,
    positiveControlHits: res1.positiveControlHits,
  });

  console.log("Running Arm 2 (den-docs)...");
  const res2 = await verifyBankIsolation(
    genie,
    denLaw,
    "den documentation and runnable templates",
    "den-docs",
  );
  assert.equal(res2.seedFound, true, "Seed entry 'den-docs' must be found");
  assert.equal(res2.seedDocumentId, "den-docs");
  assert.equal(res2.denLawHitsInGenie, 0, "No den-law entries may leak into genie recall");
  assert.ok(
    res2.positiveControlHits > 0,
    `Positive control on den-law must hit (>0, got ${res2.positiveControlHits})`,
  );
  console.log("✔ Arm 2 passed:", {
    genieHits: res2.genieHits,
    seedDoc: res2.seedDocumentId,
    leakedFromDenLaw: res2.denLawHitsInGenie,
    positiveControlHits: res2.positiveControlHits,
  });

  console.log("\nALL LIVE GATING ORACLE CHECKS PASSED.");
}

main().catch((err) => {
  console.error("Live gating oracle FAILED:", err);
  process.exit(1);
});
