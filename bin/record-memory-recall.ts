#!/usr/bin/env node
// Read-only recorder script for live bank recall results (Unit C2.2, Amendment 6).
//
// Queries Hindsight bank 'genie-memory' using the recall-only client (HindsightRecallClient)
// for each question in the question set, and saves the fixtures to a JSON file.
//
// Usage:
//   bin/record-memory-recall.ts [--questions <path>] [--out <path>] [--endpoint <url>]

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import {
  DEFAULT_HINDSIGHT_ENDPOINT,
  GENIE_MEMORY_BANK_ID,
  HindsightRecallClient,
} from "../src/bank/index.ts";

function parseArgs(args: string[]) {
  const options: Record<string, string> = {};
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
    }
  }
  return options;
}

export interface QuestionRecord {
  id: string;
  question: string;
  expected_claims?: string[];
  expected_citations?: string[];
  expected_answer?: string;
}

export interface RecallFixtureRecord {
  metadata: {
    bank_id: string;
    endpoint?: string;
    recorded_at?: string;
    stand_in: boolean;
  };
  fixtures: Record<
    string,
    {
      query: string;
      results: Array<{
        document_id?: string | null;
        text?: string;
        tags?: string[];
        scores?: {
          final?: number;
          reranker?: number;
          semantic?: number;
          keyword?: number;
        };
      }>;
    }
  >;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const questionsPath =
    options["questions"] ?? "tests/fixtures/memory-eval/questions.jsonl";
  const outPath =
    options["out"] ?? "tests/fixtures/memory-eval/recall-fixtures.json";
  const endpoint = options["endpoint"] ?? DEFAULT_HINDSIGHT_ENDPOINT;

  const client = new HindsightRecallClient(endpoint, GENIE_MEMORY_BANK_ID);

  const raw = readFileSync(questionsPath, "utf8");
  const questions: QuestionRecord[] = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  console.log(
    `Recording recall fixtures for ${questions.length} questions from ${endpoint} (bank: ${GENIE_MEMORY_BANK_ID})...`,
  );

  const output: RecallFixtureRecord = {
    metadata: {
      bank_id: GENIE_MEMORY_BANK_ID,
      endpoint,
      recorded_at: new Date().toISOString(),
      stand_in: false,
    },
    fixtures: {},
  };

  for (const q of questions) {
    process.stderr.write(`Querying: [${q.id}] ${q.question.slice(0, 50)}... `);
    try {
      const res = await client.recall({ query: q.question });
      output.fixtures[q.id] = {
        query: q.question,
        results: (res.results ?? []).map((r) => ({
          document_id: r.document_id,
          text: r.text,
          tags: r.tags,
          scores: r.scores,
        })),
      };
      console.log(`OK (${res.results?.length ?? 0} results)`);
    } catch (err) {
      console.error(`FAILED: ${(err as Error).message}`);
      throw err;
    }
  }

  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Saved recall fixtures to ${outPath}`);
}

if (process.argv[1]?.endsWith("record-memory-recall.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
