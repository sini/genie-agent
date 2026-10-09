// The wire contracts, one JSON Schema each under schemas/<name>.json.
export const schemaNames = [
  "verdict",
  "draft",
  "eval-request",
  "eval-result",
  "escalation",
  "proposal",
  "thread-state",
] as const;

export type SchemaName = (typeof schemaNames)[number];
