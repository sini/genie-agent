// The genie hindsight memory bank client and isolation oracle (Unit H1, design row 8, §6).
//
// The genie hindsight bank holds curated support knowledge, verified solutions, and distilled Q&A.
// Bank config is managed via the hindsight dataplane API at 10.11.0.20:8888, isolated from den-law.

export interface BankConfig {
  name?: string;
  mission?: string;
  reflect_mission?: string;
  retain_mission?: string;
  retain_extraction_mode?: string;
  disposition_skepticism?: number;
  disposition_literalism?: number;
  disposition_empathy?: number;
  enable_observations?: boolean;
  enable_temporal_retrieval?: boolean;
  enable_graph_retrieval?: boolean;
  enable_reranking?: boolean;
  [key: string]: unknown;
}

export interface BankRecallItem {
  id: string;
  text: string;
  type: string;
  document_id?: string | null;
  tags?: string[];
  entities?: string[];
  scores?: {
    final?: number;
    reranker?: number;
    semantic?: number;
    keyword?: number;
  };
}

export interface BankRecallResponse {
  results: BankRecallItem[];
  entities?: Record<string, unknown>;
}

export interface BankRecallRequest {
  query: string;
  types?: string[];
  budget?: "low" | "mid" | "high";
  max_tokens?: number;
  tags?: string[];
  tags_match?: "any" | "all" | "any_strict" | "all_strict" | "exact";
  min_scores?: {
    reranker?: number;
    semantic?: number;
    keyword?: number;
    final?: number;
  };
}

export interface BankRetainItem {
  content: string;
  document_id?: string;
  context?: string;
  tags?: string[];
  strategy?: string;
  update_mode?: "replace" | "append";
}

export interface BankRetainRequest {
  items: BankRetainItem[];
  async?: boolean;
}

export interface BankRetainResponse {
  success: boolean;
  bank_id: string;
  items_count: number;
  usage?: Record<string, number>;
}

export const DEFAULT_HINDSIGHT_ENDPOINT = process.env.HINDSIGHT_ENDPOINT ?? "http://10.11.0.20:8888";
export const GENIE_BANK_ID = "genie";
export const DEN_LAW_BANK_ID = "den-law";

export const GENIE_BANK_CONFIG: BankConfig = {
  name: "genie",
  mission:
    "You are the support knowledge bank for @genie, answering den/gen/Nix questions in Matrix rooms. You hold accepted solutions, verified diagnostic steps, and curated support facts. When consulted, provide verified solutions and context relevant to the user's issue. When nothing in memory addresses the problem, state that clearly.",
  reflect_mission:
    "You are the support knowledge bank for @genie, answering den/gen/Nix questions in Matrix rooms. You hold accepted solutions, verified diagnostic steps, and curated support facts. When consulted, provide verified solutions and context relevant to the user's issue. When nothing in memory addresses the problem, state that clearly.",
  retain_mission:
    "This bank holds curated support knowledge and distilled Q&A for @genie. Extract only: (1) verified technical solutions for den, gen, and Nix configurations; (2) diagnostic steps and resolution patterns; (3) evaluated configuration behaviors and error explanations. Omit transient conversation, greetings, user handles, and unverified proposals.",
  retain_extraction_mode: "verbatim",
  disposition_skepticism: 3,
  disposition_literalism: 4,
  disposition_empathy: 2,
  enable_observations: true,
  enable_temporal_retrieval: true,
  enable_graph_retrieval: true,
  enable_reranking: true,
};

// Recall-only client used by the genie process (supervisor, distiller, eval launcher, etc.).
// Structural guarantee (Oracle 20): retains and bank-writes are impossible because retain is absent.
export class HindsightRecallClient {
  readonly endpoint: string;
  readonly bankId: string;

  constructor(endpoint: string = DEFAULT_HINDSIGHT_ENDPOINT, bankId: string = GENIE_BANK_ID) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.bankId = bankId;
  }

  async getProfile(): Promise<unknown> {
    const res = await fetch(`${this.endpoint}/v1/default/banks/${encodeURIComponent(this.bankId)}/profile`);
    if (!res.ok) throw new Error(`getProfile failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  async getConfig(): Promise<{ bank_id: string; config: Record<string, unknown>; overrides: Record<string, unknown> }> {
    const res = await fetch(`${this.endpoint}/v1/default/banks/${encodeURIComponent(this.bankId)}/config`);
    if (!res.ok) throw new Error(`getConfig failed (${res.status}): ${await res.text()}`);
    return res.json() as any;
  }

  async recall(req: BankRecallRequest): Promise<BankRecallResponse> {
    const res = await fetch(`${this.endpoint}/v1/default/banks/${encodeURIComponent(this.bankId)}/memories/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`recall failed (${res.status}): ${await res.text()}`);
    return res.json() as Promise<BankRecallResponse>;
  }

  async listMemories(): Promise<{ items: BankRecallItem[]; total: number }> {
    const res = await fetch(`${this.endpoint}/v1/default/banks/${encodeURIComponent(this.bankId)}/memories/list`);
    if (!res.ok) throw new Error(`listMemories failed (${res.status}): ${await res.text()}`);
    return res.json() as any;
  }
}

// Write client used ONLY by the separate review CLI executable (genie-bank-review).
// Requires human operator authorization credential (token).
export class HindsightWriteClient extends HindsightRecallClient {
  readonly writeCredential?: string;

  constructor(
    endpoint: string = DEFAULT_HINDSIGHT_ENDPOINT,
    bankId: string = GENIE_BANK_ID,
    writeCredential?: string,
  ) {
    super(endpoint, bankId);
    this.writeCredential = writeCredential;
  }

  async createOrUpdate(config: BankConfig = GENIE_BANK_CONFIG): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.writeCredential) {
      headers["Authorization"] = `Bearer ${this.writeCredential}`;
    }
    const res = await fetch(`${this.endpoint}/v1/default/banks/${encodeURIComponent(this.bankId)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`createOrUpdate failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  async retain(req: BankRetainRequest): Promise<BankRetainResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.writeCredential) {
      headers["Authorization"] = `Bearer ${this.writeCredential}`;
    }
    const res = await fetch(`${this.endpoint}/v1/default/banks/${encodeURIComponent(this.bankId)}/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`retain failed (${res.status}): ${await res.text()}`);
    return res.json() as Promise<BankRetainResponse>;
  }
}

export interface BankIsolationResult {
  genieHits: number;
  seedFound: boolean;
  seedDocumentId?: string;
  denLawHitsInGenie: number;
  positiveControlHits: number;
  positiveControlSeedFoundInDenLaw: boolean;
}

export async function verifyBankIsolation(
  genieClient: HindsightRecallClient,
  denLawClient: HindsightRecallClient,
  query: string,
  expectedSeedDocId: string,
): Promise<BankIsolationResult> {
  const genieRecall = await genieClient.recall({ query });
  const genieResults = genieRecall.results ?? [];

  const seedHit = genieResults.find(
    (r) => r.document_id === expectedSeedDocId || (r.text && r.text.includes(expectedSeedDocId)),
  );
  if (!seedHit) {
    throw new Error(
      `Oracle failure: seed entry ${expectedSeedDocId} not returned from genie bank (got ${genieResults.length} hits)`,
    );
  }

  const denLawHits = genieResults.filter((r) => {
    if (r.tags?.includes("tier:law") || r.tags?.includes("tier:trap")) return true;
    if (r.text && (r.text.includes("RULE —") || r.text.includes("STANDING LAW"))) return true;
    return false;
  });
  if (denLawHits.length > 0) {
    throw new Error(`Oracle failure: genie bank leaked ${denLawHits.length} entry(ies) from den-law`);
  }

  const denLawRecall = await denLawClient.recall({ query });
  const denLawResults = denLawRecall.results ?? [];
  if (denLawResults.length === 0) {
    throw new Error(`Positive control failure: query '${query}' returned 0 hits on den-law`);
  }

  const seedInDenLaw = denLawResults.some((r) => r.document_id === expectedSeedDocId);
  if (seedInDenLaw) {
    throw new Error(`Cross-contamination: seed entry ${expectedSeedDocId} unexpectedly found in den-law`);
  }

  return {
    genieHits: genieResults.length,
    seedFound: true,
    seedDocumentId: seedHit.document_id ?? expectedSeedDocId,
    denLawHitsInGenie: 0,
    positiveControlHits: denLawResults.length,
    positiveControlSeedFoundInDenLaw: false,
  };
}

// Re-exports for review queue, distiller, and human approval gate (Unit H2)
export * from "./queue.ts";
export * from "./distiller.ts";
export * from "./cli.ts";

