// Distiller support memory extraction and queueing (Unit H2, plan row H2, design §6, Oracle 20).
//
// Extracts candidate support memory from accepted threads and submits to the persistent review queue.
// Invariants (Oracle 20):
// - The distiller runs inside the genie model process.
// - It holds ONLY enqueue access to the review queue on disk.
// - It holds NO bank-write credential and its bank client is recall-only (HindsightRecallClient).
// - No code path in the distiller or genie process can retain to the bank.

import type { HindsightRecallClient } from "./index.ts";
import {
  type CandidateEntry,
  type CandidateInput,
  type ReviewQueue,
} from "./queue.ts";

export interface ThreadTranscript {
  threadId: string;
  userQuestion: string;
  diagnosticSteps: string[];
  acceptedSolution: string;
  documentIdSlug: string;
  tags?: string[];
}

export class Distiller {
  private queue: ReviewQueue;
  private recallClient?: HindsightRecallClient;

  constructor(queue: ReviewQueue, recallClient?: HindsightRecallClient) {
    this.queue = queue;
    this.recallClient = recallClient;
  }

  // Distill an accepted resolution thread into a CandidateInput
  distillThread(transcript: ThreadTranscript): CandidateInput {
    return {
      threadId: transcript.threadId,
      documentId: transcript.documentIdSlug,
      title: transcript.userQuestion.slice(0, 80),
      problem: transcript.userQuestion,
      solution: transcript.acceptedSolution,
      diagnosticSteps: transcript.diagnosticSteps,
      tags: transcript.tags ?? ["tier:support"],
    };
  }

  // Accept a thread resolution:
  // Extracts candidate, runs deterministic checks, and enqueues to disk for human review.
  // accept => queue grows by 1, bank grows by 0.
  acceptResolution(transcript: ThreadTranscript): {
    candidate: CandidateEntry;
    admittedToQueue: boolean;
  } {
    const candidateInput = this.distillThread(transcript);
    return this.queue.enqueue(candidateInput);
  }
}

