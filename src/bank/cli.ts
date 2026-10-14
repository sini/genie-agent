// Owner Review CLI library for Support Memory Candidates (Unit H2, Oracle 20).
//
// This is the human approval path.
// It runs as a separate process from the genie agent.
// It alone holds the Hindsight bank write credential (token).
// Model processes have no access to this class or its write credential.

import fs from "node:fs";
import {
  DEFAULT_HINDSIGHT_ENDPOINT,
  GENIE_BANK_ID,
  HindsightWriteClient,
  type BankRetainResponse,
} from "./index.ts";
import {
  ReviewQueue,
  runDeterministicChecks,
  type CandidateEntry,
} from "./queue.ts";

export interface ReviewApproverOptions {
  queueDir: string;
  endpoint?: string;
  bankId?: string;
  writeCredential?: string;
  writeCredentialFile?: string;
  operatorId?: string;
}

export class ReviewApprover {
  readonly queue: ReviewQueue;
  readonly writeClient: HindsightWriteClient;
  readonly operatorId: string;

  constructor(opts: ReviewApproverOptions) {
    this.queue = new ReviewQueue(opts.queueDir);
    this.operatorId = opts.operatorId ?? "owner";

    let cred: string | undefined;
    if (opts.writeCredentialFile) {
      if (!fs.existsSync(opts.writeCredentialFile)) {
        throw new Error(`Write token file not found: ${opts.writeCredentialFile}`);
      }
      cred = fs.readFileSync(opts.writeCredentialFile, "utf8").trim();
    } else if (opts.writeCredential && opts.writeCredential.trim() !== "") {
      cred = opts.writeCredential.trim();
    } else if (process.env.HINDSIGHT_WRITE_TOKEN && process.env.HINDSIGHT_WRITE_TOKEN.trim() !== "") {
      cred = process.env.HINDSIGHT_WRITE_TOKEN.trim();
    }

    const endpoint = opts.endpoint ?? process.env.HINDSIGHT_ENDPOINT ?? DEFAULT_HINDSIGHT_ENDPOINT;
    const bankId = opts.bankId ?? GENIE_BANK_ID;

    this.writeClient = new HindsightWriteClient(endpoint, bankId, cred);
  }

  listPending(): CandidateEntry[] {
    return this.queue.list("pending");
  }

  show(candidateId: string): CandidateEntry | undefined {
    return this.queue.get(candidateId);
  }

  async approve(candidateId: string): Promise<{
    success: boolean;
    candidate: CandidateEntry;
    retainResult: BankRetainResponse;
  }> {
    const candidate = this.queue.get(candidateId);
    if (!candidate) {
      throw new Error(`Candidate not found: ${candidateId}`);
    }

    if (candidate.status !== "pending") {
      throw new Error(`Cannot approve candidate with status '${candidate.status}': ${candidateId}`);
    }

    // Deterministic checks run again at approve time and may still refuse
    const recheck = runDeterministicChecks(candidate, candidate.content);
    if (!recheck.passed) {
      throw new Error(`Approve-time check refused: ${recheck.reason}`);
    }

    // Retain to hindsight bank via write client
    const retainResult = await this.writeClient.retain({
      items: [
        {
          content: candidate.content,
          document_id: candidate.documentId,
          tags: candidate.tags,
        },
      ],
    });

    const updated = this.queue.markApproved(candidateId, this.operatorId);

    return {
      success: true,
      candidate: updated,
      retainResult,
    };
  }
}
