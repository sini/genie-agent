// The genie support memory review queue (Unit H2, plan row H2, design §6, Oracle 20).
//
// Invariants (Oracle 20):
// 1. Nothing is written to the hindsight bank before a human approves it.
// 2. Deterministic checks may only refuse; they can never admit.
// 3. accept => the review queue grows by 1 and the bank by 0.
// 4. approve => the bank grows by 1.
// 5. A check-passing entry with no approval stays out of the bank.
// 6. Persistent by construction: one candidate file per entry under <queueDir>/pending, refused, or approved.
// 7. Process & credential boundary: the genie process holds enqueue only, writing to <queueDir>,
//    with NO bank-write credential and a recall-only bank client.
//    Approval is executed by a separate CLI process (genie-bank-review) held by the human owner.

import fs from "node:fs";
import path from "node:path";

export interface CandidateInput {
  threadId: string;
  documentId: string;
  title: string;
  problem: string;
  solution: string;
  diagnosticSteps: string[];
  tags: string[];
}

export interface CandidateEntry extends CandidateInput {
  id: string;
  content: string;
  status: "pending" | "refused" | "approved";
  createdAt: string;
  refusalReason?: string;
  approvedAt?: string;
  approvedBy?: string;
}

export interface CheckResult {
  passed: boolean;
  reason?: string;
}

// Credential shapes that trigger deterministic refusal (design §5.2 layer 6, S1).
const CREDENTIAL_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "ssh-private-key", re: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  { kind: "pem-private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { kind: "claude-oauth-token", re: /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/ },
  { kind: "anthropic-api-key", re: /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/ },
  { kind: "github-pat", re: /github_pat_[A-Za-z0-9_]{22,}/ },
  { kind: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: "matrix-access-token", re: /syt_[A-Za-z0-9+/]+_[A-Za-z0-9]{20}_[A-Za-z0-9]{6}/ },
  { kind: "age-secret-key", re: /AGE-SECRET-KEY-1[0-9A-Z]{50,}/ },
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
];

// Private memory and fleet governance markers that may never enter support memory.
const PRIVATE_MEMORY_MARKERS = [
  "PRIVATE_MEMORY_MARKER",
  "tier:law",
  "tier:trap",
  "fleet:private",
  "CONFIDENTIAL",
];

// Format distilled fields into a Markdown document for Hindsight retention.
export function formatCandidateContent(input: CandidateInput): string {
  const steps = input.diagnosticSteps && input.diagnosticSteps.length > 0
    ? input.diagnosticSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "None recorded";

  return [
    `# ${input.title}`,
    "",
    "## Problem",
    input.problem,
    "",
    "## Diagnostic Steps",
    steps,
    "",
    "## Verified Solution",
    input.solution,
  ].join("\n");
}

// Deterministic Refusal Checks: MAY ONLY REFUSE.
// A passing check never admits; it only allows candidate to enter "pending" review state on disk.
export function runDeterministicChecks(input: CandidateInput, formattedContent?: string): CheckResult {
  const content = formattedContent ?? formatCandidateContent(input);
  const corpus = `${input.documentId} ${input.title} ${input.problem} ${input.solution} ${(input.diagnosticSteps ?? []).join(" ")} ${content}`;

  // 1. Refuse on credential shapes
  for (const { kind, re } of CREDENTIAL_PATTERNS) {
    if (re.test(corpus)) {
      return { passed: false, reason: `Refused: credential shape detected (${kind})` };
    }
  }

  // 2. Refuse on private memory markers
  for (const marker of PRIVATE_MEMORY_MARKERS) {
    if (corpus.includes(marker)) {
      return { passed: false, reason: `Refused: private memory marker detected (${marker})` };
    }
    if (input.tags?.includes(marker)) {
      return { passed: false, reason: `Refused: private memory tag detected (${marker})` };
    }
  }

  // 3. Refuse on malformed or empty fields
  if (!input.documentId || !/^[a-z0-9-]+$/.test(input.documentId)) {
    return { passed: false, reason: "Refused: documentId must be a non-empty alphanumeric kebab-case slug" };
  }
  if (!input.title || input.title.trim().length < 5) {
    return { passed: false, reason: "Refused: title must be at least 5 characters" };
  }
  if (!input.problem || input.problem.trim().length < 5) {
    return { passed: false, reason: "Refused: problem description must be at least 5 characters" };
  }
  if (!input.solution || input.solution.trim().length < 5) {
    return { passed: false, reason: "Refused: solution must be at least 5 characters" };
  }

  return { passed: true };
}

// Persistent Review Queue: one file per entry on disk under <queueDir>/<status>/<id>.json
export class ReviewQueue {
  readonly queueDir: string;
  readonly pendingDir: string;
  readonly approvedDir: string;
  readonly refusedDir: string;

  constructor(queueDir: string) {
    this.queueDir = queueDir;
    this.pendingDir = path.join(queueDir, "pending");
    this.approvedDir = path.join(queueDir, "approved");
    this.refusedDir = path.join(queueDir, "refused");

    fs.mkdirSync(this.pendingDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.approvedDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.refusedDir, { recursive: true, mode: 0o700 });
  }

  // Enqueue candidate:
  // Runs deterministic checks.
  // Writes candidate JSON to disk under pending/ (or refused/).
  // The genie process has no bank client write credential and never touches the bank.
  // accept => queue grows by 1, bank grows by 0.
  enqueue(input: CandidateInput): { candidate: CandidateEntry; admittedToQueue: boolean } {
    const id = `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const content = formatCandidateContent(input);

    const check = runDeterministicChecks(input, content);
    if (!check.passed) {
      const refused: CandidateEntry = {
        ...input,
        id,
        content,
        status: "refused",
        createdAt: new Date().toISOString(),
        refusalReason: check.reason,
      };
      fs.writeFileSync(path.join(this.refusedDir, `${id}.json`), JSON.stringify(refused, null, 2));
      return { candidate: refused, admittedToQueue: false };
    }

    const pending: CandidateEntry = {
      ...input,
      id,
      content,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(this.pendingDir, `${id}.json`), JSON.stringify(pending, null, 2));
    return { candidate: pending, admittedToQueue: true };
  }

  get(id: string): CandidateEntry | undefined {
    for (const dir of [this.pendingDir, this.approvedDir, this.refusedDir]) {
      const p = path.join(dir, `${id}.json`);
      if (fs.existsSync(p)) {
        try {
          return JSON.parse(fs.readFileSync(p, "utf8")) as CandidateEntry;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  list(status: "pending" | "refused" | "approved" = "pending"): CandidateEntry[] {
    const dir = status === "pending" ? this.pendingDir : status === "approved" ? this.approvedDir : this.refusedDir;
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".json"));
    const entries: CandidateEntry[] = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        entries.push(JSON.parse(raw));
      } catch {
        // ignore corrupted file
      }
    }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  markApproved(id: string, operatorId: string): CandidateEntry {
    const pendingPath = path.join(this.pendingDir, `${id}.json`);
    if (!fs.existsSync(pendingPath)) {
      throw new Error(`Candidate not found in pending queue: ${id}`);
    }

    const candidate = JSON.parse(fs.readFileSync(pendingPath, "utf8")) as CandidateEntry;
    candidate.status = "approved";
    candidate.approvedBy = operatorId;
    candidate.approvedAt = new Date().toISOString();

    const approvedPath = path.join(this.approvedDir, `${id}.json`);
    fs.writeFileSync(approvedPath, JSON.stringify(candidate, null, 2));
    fs.unlinkSync(pendingPath);

    return candidate;
  }

  size(status?: "pending" | "refused" | "approved"): number {
    if (status) {
      return this.list(status).length;
    }
    return this.list("pending").length + this.list("approved").length + this.list("refused").length;
  }
}
