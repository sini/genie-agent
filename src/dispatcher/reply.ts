// Validation of genie-expert structured replies against schemas/expert-reply.json (GE1, GS1 OQ1 Arm A).
// Kept self-contained in src/dispatcher/ so the genie-dispatcher SEA binary validates replies
// without runtime filesystem dependencies, while tests/delivery.test.ts verifies equivalence with
// schemas/expert-reply.json across all valid and invalid schema fixtures.

export interface ExpertReply {
  answer: string;
  confidence: number;
  gaps: string[];
  tier: "expert";
  escalate?: boolean;
}

export type ExpertReplyValidation =
  | { ok: true; value: ExpertReply }
  | { ok: false; error: string; errors: string[] };

const REQUIRED_FIELDS = ["answer", "confidence", "gaps", "tier"] as const;
const ALLOWED_FIELDS = new Set<string>(["answer", "confidence", "gaps", "tier", "escalate"]);

export function validateExpertReply(val: unknown): ExpertReplyValidation {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    const msg = "$: expected object";
    return { ok: false, error: msg, errors: [msg] };
  }
  const obj = val as Record<string, unknown>;
  const errs: string[] = [];

  for (const req of REQUIRED_FIELDS) {
    if (!(req in obj)) {
      errs.push(`$: missing required property '${req}'`);
    }
  }

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FIELDS.has(key)) {
      errs.push(`$: additional property '${key}' not allowed`);
    }
  }

  if ("answer" in obj) {
    if (typeof obj.answer !== "string") {
      errs.push("$.answer: expected string");
    } else if (obj.answer.length < 1) {
      errs.push("$.answer: length 0 < minLength 1");
    }
  }

  if ("confidence" in obj) {
    if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
      errs.push("$.confidence: expected number");
    } else {
      if (obj.confidence < 0) errs.push(`$.confidence: ${obj.confidence} < minimum 0`);
      if (obj.confidence > 1) errs.push(`$.confidence: ${obj.confidence} > maximum 1`);
    }
  }

  if ("gaps" in obj) {
    if (!Array.isArray(obj.gaps)) {
      errs.push("$.gaps: expected array");
    } else {
      obj.gaps.forEach((item, i) => {
        if (typeof item !== "string") {
          errs.push(`$.gaps[${i}]: expected string`);
        }
      });
    }
  }

  if ("tier" in obj && obj.tier !== "expert") {
    errs.push(`$.tier: expected const ${JSON.stringify("expert")}`);
  }

  if ("escalate" in obj && typeof obj.escalate !== "boolean") {
    errs.push("$.escalate: expected boolean");
  }

  if (errs.length > 0) {
    return { ok: false, error: errs.join("; "), errors: errs };
  }

  const reply: ExpertReply = {
    answer: obj.answer as string,
    confidence: obj.confidence as number,
    gaps: [...(obj.gaps as string[])],
    tier: "expert",
    ...(typeof obj.escalate === "boolean" ? { escalate: obj.escalate } : {}),
  };
  return { ok: true, value: reply };
}

export function parseExpertReply(raw: string): ExpertReplyValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const msg = `$: invalid JSON (${(e as Error).message})`;
    return { ok: false, error: msg, errors: [msg] };
  }
  return validateExpertReply(parsed);
}
