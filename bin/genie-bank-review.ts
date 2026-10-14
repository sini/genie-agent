#!/usr/bin/env node
// Standalone review CLI executable: genie-bank-review (Unit H2, Oracle 20).
//
// Invoked exclusively by the human owner/operator from a host terminal.
// Separate process from the genie root/supervisor. Holds the bank write credential.
//
// Usage:
//   genie-bank-review list [--queue-dir <path>]
//   genie-bank-review show <candidate-id> [--queue-dir <path>]
//   genie-bank-review approve <candidate-id> [--queue-dir <path>] [--endpoint <url>] [--write-token <token>]

import path from "node:path";
import { ReviewApprover } from "../src/bank/cli.ts";

function parseArgs(args: string[]) {
  const options: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = "true";
      }
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0], id: positional[1], options };
}

async function main() {
  const { command, id, options } = parseArgs(process.argv.slice(2));

  if (options["write-token"]) {
    console.error(
      "Warning: --write-token is deprecated (token is visible in ps); use --write-token-file instead",
    );
  }

  const queueDir = options["queue-dir"] ?? process.env.GENIE_REVIEW_QUEUE_DIR ?? path.join(process.cwd(), "review-queue");
  const endpoint = options["endpoint"] ?? process.env.HINDSIGHT_ENDPOINT;
  const writeCredential = options["write-token"];
  const writeCredentialFile = options["write-token-file"];

  const approver = new ReviewApprover({
    queueDir,
    endpoint,
    writeCredential,
    writeCredentialFile,
    operatorId: options["operator"] ?? "owner",
  });

  if (command === "list" || !command) {
    const pending = approver.listPending();
    if (pending.length === 0) {
      console.log("No pending candidates in review queue.");
      return;
    }
    console.log(`Pending candidates (${pending.length}):`);
    for (const c of pending) {
      console.log(`- [${c.id}] ${c.title} (${c.documentId})`);
    }
    return;
  }

  if (command === "show") {
    if (!id) {
      console.error("Error: candidate ID required for 'show'");
      process.exit(1);
    }
    const c = approver.show(id);
    if (!c) {
      console.error(`Candidate not found: ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(c, null, 2));
    return;
  }

  if (command === "approve") {
    if (!id) {
      console.error("Error: candidate ID required for 'approve'");
      process.exit(1);
    }
    try {
      const res = await approver.approve(id);
      console.log(`Approved candidate ${id} => retained into hindsight bank.`);
      console.log(`Document ID: ${res.candidate.documentId}`);
      console.log(`Approved by: ${res.candidate.approvedBy}`);
    } catch (err: any) {
      console.error(`Approval failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${command}. Expected 'list', 'show', or 'approve'.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
