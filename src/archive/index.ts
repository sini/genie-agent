// The permanent archive (plan P4, design §6): a tier-1 thread's transcript, guard verdicts,
// escalation package and broker actions, written as one JSON object to Garage S3, bucket
// `genie-transcripts`. P3's collection awaits `archive(thread)` before it removes anything, so a
// rejection keeps the thread whole.
//
// Key: `tier1/<sender_tier>/<thread>.json`, so the two tiers never share a prefix, and neither
// shares one with the expert archiver's `expert/public/` (I17). One key per thread: archiving again
// overwrites, and since pi's session only appends, the later object holds the earlier one's
// transcript. A section with no producer is present as `null`, its reason under `absent`.
//
// The S3 client is a single SigV4-signed PUT, path-style, over fetch. The secret key is read from
// a file at archive time, never from argv or the environment (as G3).
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { GcOptions } from "../gc/index.ts";
import type { ThreadStateStore } from "../state/index.ts";

export interface S3Config {
  endpoint: string; // e.g. http://garage:3900
  region: string; // Garage's `s3_region`
  bucket: string;
  accessKeyId: string;
  secretKeyFile: string;
}

export const BUCKET = "genie-transcripts";

// Sections with no store to read them from yet; each is owed by the named producer.
const ABSENT = {
  verdicts: "guard verdicts are not persisted by any producer yet (genie-guard, S3/S4)",
  actions: "broker actions are returned, not persisted, by A1's broker",
};

export const objectKey = (tier: string, thread: string) => `tier1/${tier}/${thread}.json`;

// Everything the archive holds for a thread, from P2's state directory.
export function archiveObject(store: ThreadStateStore, thread: string, now = new Date()) {
  const state = store.read(thread);
  if (!state) throw new Error(`archive: thread ${thread} has no state`);
  const args = store.sessionArgs(thread);
  const session = `${args[args.indexOf("--session-dir") + 1]}/${args[args.indexOf("--session-id") + 1]}.jsonl`;
  const escalation = store.escalation(thread) ?? null;
  const absent: Record<string, string> = { ...ABSENT };
  if (!existsSync(session)) absent.transcript = "pi wrote no session: the thread closed before its first reply";
  if (!escalation) absent.escalation = "the thread never escalated";
  return {
    key: objectKey(state.sender_tier, thread),
    body: {
      thread,
      tier: state.sender_tier,
      status: state.status,
      created: state.created,
      last_active: state.last_active,
      archived_at: now.toISOString(),
      transcript: existsSync(session) ? readFileSync(session, "utf8") : null,
      verdicts: null,
      escalation,
      actions: null,
      absent,
    },
  };
}

// The function P3's GC takes: resolves once the object is stored, rejects otherwise.
export function archiver(store: ThreadStateStore, s3: S3Config): GcOptions["archive"] {
  return async (thread) => {
    const { key, body } = archiveObject(store, thread);
    await put(s3, key, JSON.stringify(body));
  };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (k: string | Uint8Array, s: string) => createHmac("sha256", k).update(s).digest();
// S3's URI encoding: RFC 3986 unreserved characters stay, everything else is %XX.
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// The SigV4 headers for a path-style PUT of body at /<bucket>/<key>.
export function sign(s3: S3Config, secret: string, key: string, body: string, now: Date) {
  const url = new URL(s3.endpoint);
  const uri = `/${enc(s3.bucket)}/${key.split("/").map(enc).join("/")}`;
  const amzDate = now.toISOString().replace(/[-:]|\.\d+/g, "");
  const day = amzDate.slice(0, 8);
  const hash = sha256(body);
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["PUT", uri, "", `host:${url.host}`, `x-amz-content-sha256:${hash}`, `x-amz-date:${amzDate}`, "", signed, hash].join("\n");
  const scope = `${day}/${s3.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSigning = ["s3", "aws4_request"].reduce(hmac, hmac(hmac(`AWS4${secret}`, day), s3.region));
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return {
    url: `${url.origin}${uri}`,
    headers: {
      "x-amz-content-sha256": hash,
      "x-amz-date": amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${s3.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
  };
}

async function put(s3: S3Config, key: string, body: string): Promise<void> {
  const secret = readFileSync(s3.secretKeyFile, "utf8").trim();
  if (!secret) throw new Error(`archive: secret key empty: ${s3.secretKeyFile}`);
  const { url, headers } = sign(s3, secret, key, body, new Date());
  const res = await fetch(url, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body });
  if (!res.ok) throw new Error(`archive: PUT ${key} ⇒ HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
